#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const usage = `Usage: infra/scripts/validate-production-images.mjs [options]

Validate the built Helix application and web-edge runtime contracts.

Options:
  --application-image <ref>  Default: HELIX_IMAGE or helix/workspace:production
  --web-image <ref>          Default: HELIX_WEB_IMAGE or helix/workspace-web:production
  --help                     Show this help
`;

const applicationPayloadCheck = `
set -eu
test "$(id -u)" = "10001"
test "$(id -g)" = "10001"
test -f /app/dist/index.js
test -f /app/dist/db/migrate.js
test -d /app/dist/db/migrations
test "$(find /app/dist/db/migrations -maxdepth 1 -type f -name '*.sql' | wc -l)" -gt 0
test ! -e /app/src
test ! -e /app/.git
test ! -e /app/.env
test ! -e /app/pnpm-lock.yaml
test ! -e /app/node_modules/.pnpm-store
node --check /app/dist/index.js
`.trim();

const webPayloadCheck = `
set -eu
test "$(id -u)" = "10001"
test "$(id -g)" = "10001"
test -s /srv/index.html
test -s /etc/caddy/Caddyfile
test ! -e /srv/src
test ! -e /srv/.git
test ! -e /srv/.env
test ! -e /srv/package.json
caddy validate --config /etc/caddy/Caddyfile
`.trim();

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2), process.env);
    if (options.help) {
      process.stdout.write(usage);
      process.exit(0);
    }
    validateProductionImages(options);
    process.stdout.write(
      `validated production images: ${options.applicationImage}, ${options.webImage}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`production image validation failed: ${message}\n`);
    process.exit(1);
  }
}

export function parseArgs(args, environment = process.env) {
  const options = {
    applicationImage: environment.HELIX_IMAGE ?? "helix/workspace:production",
    webImage: environment.HELIX_WEB_IMAGE ?? "helix/workspace-web:production",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    switch (argument) {
      case "--application-image":
        options.applicationImage = value;
        break;
      case "--web-image":
        options.webImage = value;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export function validateProductionImages(options, run = execFileSync) {
  const applicationMetadata = inspectImage(options.applicationImage, run);
  const webMetadata = inspectImage(options.webImage, run);

  assertImageMetadata(applicationMetadata, {
    name: "application",
    expectedEntrypoint: ["node", "dist/index.js"],
    requiredHealthFragment: "127.0.0.1:3000/healthz",
  });
  assertImageMetadata(webMetadata, {
    name: "web",
    expectedEntrypoint: ["caddy"],
    expectedCommandPrefix: ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
    requiredHealthFragment: "127.0.0.1/healthz",
  });

  runContainerCheck(options.applicationImage, applicationPayloadCheck, ["/tmp"], {}, run);
  runContainerCheck(
    options.webImage,
    webPayloadCheck,
    ["/tmp", "/config", "/data"],
    {
      HELIX_DOMAIN: "workspace.example.invalid",
      HELIX_UPSTREAM: "http://127.0.0.1:3000",
    },
    run,
  );
}

export function assertImageMetadata(
  metadata,
  { name, expectedEntrypoint, expectedCommandPrefix, requiredHealthFragment },
) {
  if (metadata === null || typeof metadata !== "object") {
    throw new Error(`${name} image inspection returned invalid metadata`);
  }
  if (metadata.Config?.User !== "10001:10001") {
    throw new Error(`${name} image must run as UID/GID 10001:10001`);
  }
  if (
    expectedEntrypoint !== undefined &&
    JSON.stringify(metadata.Config?.Entrypoint) !== JSON.stringify(expectedEntrypoint)
  ) {
    throw new Error(`${name} image has an unexpected entrypoint`);
  }
  if (
    expectedCommandPrefix !== undefined &&
    (!Array.isArray(metadata.Config?.Cmd) ||
      !expectedCommandPrefix.every((value, index) => metadata.Config.Cmd[index] === value))
  ) {
    throw new Error(`${name} image has an unexpected command`);
  }
  const healthcheck = metadata.Config?.Healthcheck?.Test;
  if (
    !Array.isArray(healthcheck) ||
    !healthcheck.some(
      (value) => typeof value === "string" && value.includes(requiredHealthFragment),
    )
  ) {
    throw new Error(`${name} image must define its expected health check`);
  }
  if (
    typeof metadata.Id !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(metadata.Id) ||
    !Array.isArray(metadata.RootFS?.Layers) ||
    metadata.RootFS.Layers.length === 0
  ) {
    throw new Error(`${name} image must have a content-addressed local image ID and layers`);
  }
}

function inspectImage(image, run) {
  const output = run("docker", ["image", "inspect", image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`docker returned unexpected inspection output for ${image}`);
  }
  return parsed[0];
}

function runContainerCheck(image, script, writableTmpfs, environment, run) {
  const args = ["run", "--rm", "--read-only", "--network", "none"];
  for (const path of writableTmpfs) {
    args.push("--tmpfs", `${path}:rw,noexec,nosuid,size=64m`);
  }
  for (const [name, value] of Object.entries(environment)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push("--entrypoint", "sh", image, "-euc", script);
  run("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
