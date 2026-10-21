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
   credential, signals through the Workspace site at /rtc and publishes only
   the media and TURN ports. */

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
    expect(withoutMeet.services.livekit).toBeUndefined();
    const environment = withoutMeet.services.helix.environment;
    expect(environment.HELIX_APPS).toBe("mail,drive,chat,assistant");
    for (const name of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "MEET_CAPTURE_SECRET"]) {
      expect(environment, name).not.toHaveProperty(name);
    }
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
      LIVEKIT_INTERNAL_URL: "http://livekit:7880",
      MEET_CAPTURE_SECRET_FILE: "/run/secrets/meet_capture_secret",
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
    // The key list and Redis password are read from secret files at start.
    const script = service.entrypoint.join("\n");
    expect(script).toContain("cat /run/secrets/livekit_api_secret");
    expect(script).toContain("cat /run/secrets/redis_password");
    expect(script).toContain("exec /livekit-server");
    expect(service.secrets.map((secret) => secret.source).sort()).toEqual([
      "livekit_api_secret",
      "redis_ca",
      "redis_password",
      "turn_cert",
      "turn_key",
    ]);
  });

  it("configures LiveKit for the existing Redis, Helix's webhook and built-in TURN", () => {
    // The rendered YAML, exactly: Compose has already filled in the variables.
    expect(withMeet.services.livekit.environment.LIVEKIT_CONFIG.trimEnd().split("\n")).toEqual([
      "port: 7880",
      "log_level: info",
      "rtc:",
      "  tcp_port: 7881",
      "  udp_port: 7882",
      "  node_ip: 203.0.113.10",
      "  use_external_ip: false",
      "redis:",
      "  address: redis:6379",
      "  use_tls: true",
      "turn:",
      "  enabled: true",
      "  domain: turn.example.test",
      "  udp_port: 3478",
      "  tls_port: 5349",
      "  cert_file: /run/secrets/turn_cert",
      "  key_file: /run/secrets/turn_key",
      "webhook:",
      "  api_key: helix",
      "  urls:",
      "    - http://helix:3000/webhook/livekit",
    ]);
    // Redis's certificate is signed by the deployment CA.
    expect(withMeet.services.livekit.environment.SSL_CERT_FILE).toBe("/run/secrets/redis_ca");
  });

  it("publishes only the media and TURN ports, and advertises the ports it publishes", () => {
    const before = published(withoutMeet);
    expect(published(withMeet).filter((port) => !before.includes(port))).toEqual([
      "livekit 7881/tcp",
      "livekit 7882/udp",
      "livekit 3478/udp",
      "livekit 5349/tcp",
    ]);
    for (const port of withMeet.services.livekit.ports) {
      expect(String(port.published)).toBe(String(port.target));
      expect(port.mode).toBe("host");
    }
  });

  it("keeps the LiveKit API private and routes signalling through the Workspace site", () => {
    expect(Object.keys(withMeet.services.livekit.networks).sort()).toEqual(["data-plane", "edge"]);
    expect(withMeet.services.caddy.environment).toMatchObject({
      HELIX_MEET_SITE: "-on",
      HELIX_LIVEKIT_UPSTREAM: "livekit:7880",
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
});
