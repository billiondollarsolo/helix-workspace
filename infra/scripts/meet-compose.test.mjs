import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMeetSecrets, generateProductionSecrets } from "./generate-production-secrets.mjs";

/* The optional Meet install: docker-compose.meet.yml on top of the production
   stack. Without the file nothing below exists; with it Helix runs the Full
   Workspace profile against a bundled LiveKit server that holds no development
   credential, signals through the Workspace site at /rtc and runs on the host
   network so WebRTC media and TURN relaying do not pass Docker's port NAT.
   LiveKit Egress records meetings: it shares a loopback-only Redis with
   LiveKit and writes recordings to a volume Helix reads at the same path. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (character) => `sha256:${character.repeat(64)}`;
let workspace;
let withoutMeet;
let withMeet;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "helix-meet-compose-"));
  const secrets = join(workspace, "secrets");
  generateProductionSecrets({ directory: secrets, mailHost: "mail.example.test" });
  addMeetSecrets({ directory: secrets, turnHost: "turn.example.test" });
  // An empty env file keeps a developer's own .env out of the result.
  const envFile = join(workspace, "empty.env");
  writeFileSync(envFile, "");
  const environment = {
    ...process.env,
    HELIX_PRODUCTION_SECRETS_DIR: secrets,
    HELIX_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace@${digest("a")}`,
    HELIX_WEB_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-web@${digest("b")}`,
    HELIX_POSTGRES_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-postgres@${digest("c")}`,
    HELIX_NATS_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-nats@${digest("d")}`,
    HELIX_MEILISEARCH_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-meilisearch@${digest("e")}`,
    HELIX_CERBOS_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-cerbos@${digest("f")}`,
    HELIX_SPAMD_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-spamassassin@${digest("1")}`,
    HELIX_CLAMAV_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-clamav@${digest("2")}`,
    HELIX_DOMAIN: "workspace.example.test",
    HELIX_REGION: "eu-test",
    HELIX_DEFAULT_ORG_NAME: "Example Workspace",
    MAIL_PROVIDER: "postmark",
    MAIL_FROM_DOMAIN: "example.test",
    MAIL_SMTP_HOST: "smtp.postmarkapp.com",
    MAIL_SMTP_USER: "provider-user",
    HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_MEET_TURN_DOMAIN: "turn.example.test",
    HELIX_MEET_PUBLIC_IP: "203.0.113.10",
  };
  const resolveCompose = (files) =>
    JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--env-file",
          envFile,
          ...files.flatMap((file) => ["-f", file]),
          "config",
          "--format",
          "json",
        ],
        { cwd: root, encoding: "utf8", env: environment },
      ),
    );
  const production = ["docker-compose.yml", "docker-compose.production.yml"];
  withoutMeet = resolveCompose(production);
  withMeet = resolveCompose([...production, "docker-compose.meet.yml"]);
});

afterAll(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
});

const published = (compose) =>
  Object.entries(compose.services).flatMap(([service, config]) =>
    (config.ports ?? []).map((port) => `${service} ${String(port.published)}/${port.protocol}`),
  );

describe("optional Meet install", () => {
  it("deploys nothing and keeps the core packaging without its Compose file", () => {
    for (const name of ["livekit", "livekit-redis", "egress", "meet-recordings-init"])
      expect(withoutMeet.services[name], name).toBeUndefined();
    const environment = withoutMeet.services.helix.environment;
    expect(environment.HELIX_APPS).toBe("mail,drive,chat,assistant");
    for (const name of [
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "MEET_CAPTURE_SECRET",
      "MEET_RECORDING_DIR",
    ]) {
      expect(environment, name).not.toHaveProperty(name);
    }
    expect(withoutMeet.services.helix.volumes.map((volume) => volume.target)).not.toContain(
      "/recordings",
    );
    expect(Object.keys(withoutMeet.volumes)).not.toContain("meet-recordings");
    expect(withoutMeet.services.caddy.environment).not.toHaveProperty("HELIX_MEET_SITE");
    expect(published(withoutMeet).filter((port) => port.startsWith("livekit "))).toEqual([]);
  });

  it("removes every Jitsi service, secret and variable", () => {
    const rendered = JSON.stringify(withMeet);
    expect(rendered).not.toMatch(/jitsi|jibri|jicofo|prosody|coturn/iu);
    expect(rendered).not.toMatch(/MEET_JITSI_|HELIX_JITSI_ORIGIN|HELIX_MEET_DOMAIN/u);
  });

  it("switches Helix to the Full Workspace profile with file-backed LiveKit secrets", () => {
    const helix = withMeet.services.helix;
    expect(helix.environment).toMatchObject({
      HELIX_WORKSPACE_PROFILE: "full",
      HELIX_APPS: "mail,drive,chat,assistant,calendar,meet",
      LIVEKIT_API_KEY: "helix",
      LIVEKIT_API_SECRET_FILE: "/run/secrets/livekit_api_secret",
      LIVEKIT_INTERNAL_URL: "http://host.docker.internal:7880",
      MEET_CAPTURE_SECRET_FILE: "/run/secrets/meet_capture_secret",
      MEET_MEDIA_REGION: "eu-test",
      HELIX_MEET_TURN_DOMAIN: "turn.example.test",
      MEET_RECORDING_DIR: "/recordings",
    });
    expect(helix.environment.LIVEKIT_API_SECRET).toBeUndefined();
    expect(helix.environment.MEET_CAPTURE_SECRET).toBeUndefined();
    // Empty: browsers use the Workspace address unless the operator chooses another.
    expect(helix.environment.LIVEKIT_PUBLIC_URL).toBe("");
    // Neither module may be forced off once its app is in the profile.
    const modules = JSON.parse(helix.environment.HELIX_CONFIG_JSON).modules;
    expect(modules).not.toHaveProperty("meet");
    expect(modules).not.toHaveProperty("calendar");
    expect(modules).toMatchObject({ docs: { enabled: false }, editors: { enabled: false } });
    expect(helix.secrets.map((secret) => secret.source)).toEqual(
      expect.arrayContaining(["livekit_api_secret", "meet_capture_secret"]),
    );
  });

  it("runs a pinned, hardened LiveKit without a development credential", () => {
    const service = withMeet.services.livekit;
    expect(service.profiles).toBeUndefined();
    expect(service.image).toMatch(/^livekit\/livekit-server:v1\.[0-9.]+@sha256:[a-f0-9]{64}$/u);
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.user).toBe("65532:65532");
    expect(service.deploy.resources.limits).toMatchObject({ pids: 1024 });
    expect(service.environment).not.toHaveProperty("LIVEKIT_KEYS");
    const leaked = Object.entries(service.environment).filter(
      ([, value]) => typeof value === "string" && /helix_dev|change_me/u.test(value),
    );
    expect(leaked).toEqual([]);
    // The key list is read from the secret file at start.
    const script = service.entrypoint.join("\n");
    expect(script).toContain("cat /run/secrets/livekit_api_secret");
    // LiveKit's own override for the Redis password (--redis-password).
    expect(script).toContain('REDIS_PASSWORD="$$(cat /run/secrets/livekit_redis_password)"');
    expect(script).toContain("export LIVEKIT_KEYS REDIS_PASSWORD");
    expect(script).toContain("exec /livekit-server");
    expect(service.environment).not.toHaveProperty("REDIS_PASSWORD");
    expect(service.secrets.map((secret) => secret.source).sort()).toEqual([
      "livekit_api_secret",
      "livekit_redis_password",
      "turn_cert",
      "turn_key",
    ]);
  });

  it("configures LiveKit with its Redis, Helix's webhook and built-in TURN", () => {
    // The rendered YAML, exactly: Compose has already filled in the variables.
    expect(withMeet.services.livekit.environment.LIVEKIT_CONFIG.trimEnd().split("\n")).toEqual([
      "port: 7880",
      "log_level: info",
      "rtc:",
      "  tcp_port: 7881",
      "  udp_port: 7882",
      "  node_ip: 203.0.113.10",
      "  use_external_ip: false",
      "turn:",
      "  enabled: true",
      "  domain: turn.example.test",
      "  udp_port: 3478",
      "  tls_port: 5349",
      "  cert_file: /run/secrets/turn_cert",
      "  key_file: /run/secrets/turn_key",
      "redis:",
      "  address: 127.0.0.1:6390",
      "webhook:",
      "  api_key: helix",
      "  urls:",
      "    - http://127.0.0.1:33000/v1/webhook/livekit",
    ]);
    expect(withMeet.services.livekit.environment).not.toHaveProperty("SSL_CERT_FILE");
    expect(withMeet.services.livekit.depends_on).toEqual({
      "livekit-redis": { condition: "service_healthy", required: true },
    });
  });

  it("runs LiveKit on the host network and takes webhooks on Workspace's loopback port", () => {
    const service = withMeet.services.livekit;
    expect(service.network_mode).toBe("host");
    expect(service.ports).toBeUndefined();
    expect(service.networks).toBeUndefined();
    // The only new published port is Workspace's, and only on loopback.
    const before = published(withoutMeet);
    expect(published(withMeet).filter((port) => !before.includes(port))).toEqual([
      "helix 33000/tcp",
    ]);
    const webhook = withMeet.services.helix.ports.find(
      (port) => String(port.published) === "33000",
    );
    expect(webhook).toMatchObject({ host_ip: "127.0.0.1", target: 3000 });
    for (const name of ["helix", "caddy"])
      expect(withMeet.services[name].extra_hosts).toEqual(["host.docker.internal=host-gateway"]);
  });

  it("keeps the LiveKit API private and routes signalling through the Workspace site", () => {
    expect(withMeet.services.caddy.environment).toMatchObject({
      HELIX_MEET_SITE: "-on",
      HELIX_LIVEKIT_UPSTREAM: "host.docker.internal:7880",
    });
    expect(withMeet.services.caddy.environment).not.toHaveProperty("HELIX_JITSI_ORIGIN");
    const caddyfile = readFileSync(join(root, "infra/caddy/Caddyfile.production"), "utf8");
    // Imported inside the Workspace site, before the single-page app fallback.
    const site = caddyfile.slice(caddyfile.indexOf("{$HELIX_DOMAIN} {"));
    const imported = site.indexOf("\timport optional/meet{$HELIX_MEET_SITE:}.caddy");
    expect(imported).toBeGreaterThan(0);
    expect(imported).toBeLessThan(site.indexOf("\thandle {\n\t\troot * /srv"));
    expect(caddyfile).toContain("camera=(self), microphone=(self), display-capture=(self)");
    expect(caddyfile).not.toMatch(/JITSI|meet\.localhost/u);
    const route = readFileSync(join(root, "infra/caddy/optional/meet-on.caddy"), "utf8");
    expect(route).toContain("@livekit path /rtc /rtc/*");
    expect(route).toContain("reverse_proxy {$HELIX_LIVEKIT_UPSTREAM:livekit:7880} {");
    expect(route).toContain("flush_interval -1");
    expect(
      readFileSync(join(root, "infra/caddy/optional/meet.caddy"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#")),
    ).toEqual([]);
  });

  it("has every secret file it mounts written by the generator's Meet step", () => {
    const overlay = readFileSync(join(root, "docker-compose.meet.yml"), "utf8");
    const declared = [
      ...overlay
        .slice(overlay.lastIndexOf("\nsecrets:\n"))
        .matchAll(/^ {2}([a-z0-9_]+):\n {4}file: /gmu),
    ].map((match) => match[1]);
    expect(declared.sort()).toEqual([
      "livekit_api_secret",
      "livekit_redis_password",
      "meet_capture_secret",
      "turn_cert",
      "turn_key",
    ]);
    for (const name of declared) {
      expect(readFileSync(join(workspace, "secrets", name), "utf8").length, name).toBeGreaterThan(
        32,
      );
    }
    const certificate = execFileSync(
      "openssl",
      ["x509", "-noout", "-ext", "subjectAltName", "-in", join(workspace, "secrets", "turn_cert")],
      { encoding: "utf8" },
    );
    expect(certificate).toContain("DNS:turn.example.test");
    expect(() =>
      addMeetSecrets({ directory: join(workspace, "secrets"), turnHost: "turn.example.test" }),
    ).toThrow(/already holds Meet secrets/u);
  });
  it("runs a password-protected Redis for LiveKit and Egress on loopback only", () => {
    const service = withMeet.services["livekit-redis"];
    // The stack's own pinned Redis image.
    expect(service.image).toBe(withMeet.services.redis.image);
    expect(service.image).toMatch(/^redis:[0-9.]+-alpine@sha256:[a-f0-9]{64}$/u);
    expect(service.network_mode).toBe("host");
    expect(service.ports).toBeUndefined();
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.cap_add).toBeUndefined();
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(service.user).toBe("999:1000");
    expect(service.deploy.resources.limits).toMatchObject({ memory: "268435456", pids: 64 });
    expect(service.secrets.map((secret) => secret.source)).toEqual(["livekit_redis_password"]);
    // The configuration goes in on stdin, so the password is in neither the
    // process arguments nor the rendered file.
    const script = service.entrypoint.join("\n");
    expect(script).toContain("exec redis-server - <<EOF");
    for (const line of [
      "bind 127.0.0.1",
      "port 6390",
      "protected-mode yes",
      'save ""',
      "appendonly no",
      "requirepass $$(cat /run/secrets/livekit_redis_password)",
    ])
      expect(script.split("\n"), line).toContain(line);
    expect(service.environment).toBeUndefined();
    expect(service.command ?? null).toBeNull();
  });

  it("runs a pinned, sandboxed Egress on the host network with local file output only", () => {
    const service = withMeet.services.egress;
    expect(service.profiles).toBeUndefined();
    expect(service.image).toMatch(/^livekit\/egress:v1\.[0-9.]+@sha256:[a-f0-9]{64}$/u);
    expect(service.network_mode).toBe("host");
    expect(service.ports).toBeUndefined();
    expect(service.networks).toBeUndefined();
    expect(service.user).toBe("1001:0");
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    // Chrome's sandbox: LiveKit's seccomp profile and SYS_CHROOT, not SYS_ADMIN.
    expect(service.cap_add).toEqual(["SYS_CHROOT"]);
    expect(service.security_opt).toEqual([
      "no-new-privileges:true",
      "seccomp=./infra/livekit/egress-chrome-seccomp.json",
    ]);
    const profile = JSON.parse(
      readFileSync(join(root, "infra/livekit/egress-chrome-seccomp.json"), "utf8"),
    );
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(service.shm_size).toBe("1073741824");
    expect(service.deploy.resources.limits).toMatchObject({
      cpus: 4,
      memory: "4294967296",
      pids: 2048,
    });
    expect(service.depends_on).toMatchObject({
      "livekit-redis": { condition: "service_healthy" },
      livekit: { condition: "service_started" },
      "meet-recordings-init": { condition: "service_completed_successfully" },
    });
    expect(service.depends_on).not.toHaveProperty("redis");
    expect(service.secrets.map((secret) => secret.source).sort()).toEqual([
      "livekit_api_secret",
      "livekit_redis_password",
    ]);
    expect(Object.keys(service.environment)).toEqual(["EGRESS_CONFIG_BODY"]);
    // The rendered YAML, exactly. The entrypoint adds the Redis password.
    expect(service.environment.EGRESS_CONFIG_BODY.trimEnd().split("\n")).toEqual([
      "api_key: helix",
      "ws_url: ws://127.0.0.1:7880",
      "logging:",
      "  level: info",
      "health_port: 7982",
      "template_port: 7980",
      "enable_chrome_sandbox: true",
      "session_limits:",
      "  file_output_max_duration: 4h",
      "redis:",
      "  address: 127.0.0.1:6390",
    ]);
    expect(service.environment.EGRESS_CONFIG_BODY).not.toMatch(/storage:|s3:|gcp:|azure:/u);
    const script = service.entrypoint.join("\n");
    expect(service.entrypoint.slice(0, 2)).toEqual(["/tini", "--"]);
    expect(script).toContain('LIVEKIT_API_SECRET="$$(cat /run/secrets/livekit_api_secret)"');
    expect(script).toContain("password: '$$(cat /run/secrets/livekit_redis_password)'");
    expect(script).toContain("exec /entrypoint.sh");
    expect(service.healthcheck.test).toEqual([
      "CMD-SHELL",
      "curl -fsS http://127.0.0.1:7982/ >/dev/null",
    ]);
  });

  it("puts no secret value into the rendered Compose file", () => {
    const rendered = JSON.stringify(withMeet);
    for (const name of ["livekit_api_secret", "livekit_redis_password", "meet_capture_secret"]) {
      const value = readFileSync(join(workspace, "secrets", name), "utf8").trim();
      expect(rendered.includes(value), name).toBe(false);
    }
    expect(rendered).not.toMatch(/helix_dev_livekit_api_secret|change_me/u);
  });

  it("shares one recordings volume between Egress and Helix at the same path", () => {
    const mount = (service, target) =>
      withMeet.services[service].volumes.find((volume) => volume.target === target);
    for (const service of ["egress", "helix", "meet-recordings-init"]) {
      expect(mount(service, "/recordings"), service).toMatchObject({
        type: "volume",
        source: "meet-recordings",
      });
      expect(mount(service, "/recordings").read_only, service).toBeUndefined();
    }
    expect(withMeet.services.helix.environment.MEET_RECORDING_DIR).toBe("/recordings");
    expect(withMeet.services.helix.depends_on).toMatchObject({
      "meet-recordings-init": { condition: "service_completed_successfully" },
    });
    // Recordings grow in Egress's work directory, which is a volume, not memory.
    expect(mount("egress", "/home/egress/tmp")).toMatchObject({ source: "egress-tmp" });
    expect(mount("meet-recordings-init", "/egress-tmp")).toMatchObject({ source: "egress-tmp" });
    expect(Object.keys(withMeet.volumes)).toEqual(
      expect.arrayContaining(["meet-recordings", "egress-tmp"]),
    );
    // Helix (10001) owns the directory; Egress (1001, group 0) writes through
    // the group, and setgid keeps new files in group 0.
    const init = withMeet.services["meet-recordings-init"];
    expect(init.profiles).toBeUndefined();
    expect(init.network_mode).toBe("none");
    expect(init.read_only).toBe(true);
    expect(init.cap_add.sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER"]);
    expect(init.entrypoint.join("\n")).toContain("install -d -m 2770 -o 10001 -g 0 /recordings");
    expect(init.entrypoint.join("\n")).toContain("install -d -m 0700 -o 1001 -g 0 /egress-tmp");
    expect(withMeet.services.helix.user).toBe("10001:10001");
  });
});
