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
   Workspace profile against a bundled Jitsi that holds no development
   credential and publishes only the media ports. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (character) => `sha256:${character.repeat(64)}`;
let workspace;
let withoutMeet;
let withMeet;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "helix-meet-compose-"));
  const secrets = join(workspace, "secrets");
  generateProductionSecrets({ directory: secrets, mailHost: "mail.example.test" });
  addMeetSecrets({ directory: secrets, meetHost: "meet.example.test" });
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
    HELIX_MEET_DOMAIN: "meet.example.test",
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

const jitsiServices = ["jitsi-web", "jitsi-prosody", "jitsi-jicofo", "jitsi-jvb", "jitsi-turn"];
const published = (compose) =>
  Object.entries(compose.services).flatMap(([service, config]) =>
    (config.ports ?? []).map((port) => `${service} ${String(port.published)}/${port.protocol}`),
  );

describe("optional Meet install", () => {
  it("keeps root-owned XMPP secrets outside Prosody's runtime certificate paths", () => {
    const prosody = withMeet.services["jitsi-prosody"];
    for (const source of ["jitsi_xmpp_cert", "jitsi_xmpp_key"]) {
      const mounts = prosody.secrets.filter((secret) => secret.source === source);
      expect(mounts).toHaveLength(1);
      expect(mounts[0].target).toBe(`/run/secrets/${source}`);
    }
    expect(prosody.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "/etc/cont-init.d/01-helix-secrets", read_only: true }),
        expect.objectContaining({ target: "/config", type: "volume" }),
      ]),
    );
    execFileSync("sh", ["-n", join(root, "infra/meet/init/01-helix-secrets")]);
  });

  it("deploys nothing and keeps the core packaging without its Compose file", () => {
    expect(Object.keys(withoutMeet.services).filter((name) => name.startsWith("jitsi-"))).toEqual(
      [],
    );
    const environment = withoutMeet.services.helix.environment;
    expect(environment.HELIX_APPS).toBe("mail,drive,chat,assistant");
    expect(environment.MEET_JITSI_ENABLED).toBe("false");
    expect(withoutMeet.services.caddy.environment).not.toHaveProperty("HELIX_MEET_SITE");
    expect(published(withoutMeet).filter((port) => port.startsWith("jitsi-"))).toEqual([]);
  });

  it("switches Helix to the Full Workspace profile with file-backed Jitsi secrets", () => {
    const helix = withMeet.services.helix;
    expect(helix.environment).toMatchObject({
      HELIX_WORKSPACE_PROFILE: "full",
      HELIX_APPS: "mail,drive,chat,assistant,calendar,meet",
      MEET_JITSI_ENABLED: "true",
      MEET_JITSI_DOMAIN: "meet.example.test",
      MEET_JITSI_PUBLIC_URL: "https://meet.example.test",
      MEET_JITSI_REGION: "eu-test",
      MEET_JITSI_JWT_SECRET_FILE: "/run/secrets/meet_jwt_secret",
      MEET_JITSI_WEBHOOK_SHARED_SECRET_FILE: "/run/secrets/meet_webhook_secret",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://workspace.example.test,https://meet.example.test",
    });
    expect(helix.environment.MEET_JITSI_JWT_SECRET).toBeUndefined();
    expect(helix.environment.MEET_JITSI_WEBHOOK_SHARED_SECRET).toBeUndefined();
    // Neither module may be forced off once its app is in the profile.
    const modules = JSON.parse(helix.environment.HELIX_CONFIG_JSON).modules;
    expect(modules).not.toHaveProperty("meet");
    expect(modules).not.toHaveProperty("calendar");
    expect(modules).toMatchObject({ docs: { enabled: false }, editors: { enabled: false } });
    expect(helix.secrets.map((secret) => secret.source)).toEqual(
      expect.arrayContaining(["meet_jwt_secret", "meet_webhook_secret"]),
    );
  });

  it("runs Jitsi without a development credential and without a recorder", () => {
    expect(withMeet.services["jitsi-jibri"]).toBeUndefined();
    for (const name of jitsiServices) {
      const service = withMeet.services[name];
      expect(service.profiles, name).toBeUndefined();
      expect(service.security_opt, name).toEqual(["no-new-privileges:true"]);
      expect(service.image, name).toMatch(/@sha256:[a-f0-9]{64}$/u);
      const leaked = Object.entries(service.environment ?? {}).filter(
        ([, value]) => typeof value === "string" && /helix_dev|change_me/u.test(value),
      );
      expect(leaked, name).toEqual([]);
    }
    for (const name of ["jitsi-prosody", "jitsi-jicofo", "jitsi-jvb"]) {
      const environment = withMeet.services[name].environment;
      for (const credential of [
        "JICOFO_AUTH_PASSWORD",
        "JICOFO_COMPONENT_SECRET",
        "JVB_AUTH_PASSWORD",
        "JWT_APP_SECRET",
        "JIBRI_XMPP_PASSWORD",
        "JIBRI_RECORDER_PASSWORD",
      ]) {
        expect(environment, `${name} ${credential}`).not.toHaveProperty(credential);
      }
    }
    const credentialFiles = (name) =>
      withMeet.services[name].secrets
        .filter((secret) => secret.target.startsWith("/run/helix-jitsi-env/"))
        .map((secret) => `${secret.target.split("/").at(-1)}=${secret.source}`)
        .sort();
    expect(credentialFiles("jitsi-prosody")).toEqual([
      "HELIX_JITSI_WEBHOOK_SECRET=meet_webhook_secret",
      "JICOFO_AUTH_PASSWORD=jitsi_jicofo_auth_password",
      "JICOFO_COMPONENT_SECRET=jitsi_jicofo_component_secret",
      "JVB_AUTH_PASSWORD=jitsi_jvb_auth_password",
      "JWT_APP_SECRET=meet_jwt_secret",
    ]);
    expect(credentialFiles("jitsi-jicofo")).toEqual([
      "JICOFO_AUTH_PASSWORD=jitsi_jicofo_auth_password",
      "JICOFO_COMPONENT_SECRET=jitsi_jicofo_component_secret",
    ]);
    expect(credentialFiles("jitsi-jvb")).toEqual(["JVB_AUTH_PASSWORD=jitsi_jvb_auth_password"]);
    expect(withMeet.services["jitsi-web"].secrets ?? []).toEqual([]);
    expect(withMeet.services["jitsi-prosody"].environment.ENABLE_RECORDING).toBe("0");
  });

  it("verifies XMPP against the deployment CA through a trust store built at start", () => {
    const init = withMeet.services["jitsi-truststore-init"];
    expect(init.network_mode).toBe("none");
    expect(init.restart).toBe("no");
    expect(init.secrets).toEqual([
      { source: "jitsi_xmpp_ca", target: "/run/secrets/jitsi_xmpp_ca" },
    ]);
    for (const name of ["jitsi-jicofo", "jitsi-jvb"]) {
      const service = withMeet.services[name];
      expect(service.depends_on["jitsi-truststore-init"].condition).toBe(
        "service_completed_successfully",
      );
      expect(service.environment.JAVA_TOOL_OPTIONS).toContain(
        "-Djavax.net.ssl.trustStore=/run/helix-truststore/xmpp-truststore.p12",
      );
    }
    for (const file of ["jvb/custom-jvb.conf", "jicofo/custom-jicofo.conf"]) {
      expect(readFileSync(join(root, "infra/meet", file), "utf8")).toMatch(
        /certificate.verification = false/iu,
      );
    }
  });

  it("publishes only the media ports, and advertises the ports it publishes", () => {
    const before = published(withoutMeet);
    expect(published(withMeet).filter((port) => !before.includes(port))).toEqual(
      expect.arrayContaining([
        "jitsi-jvb 10000/udp",
        "jitsi-turn 3478/tcp",
        "jitsi-turn 3478/udp",
        "jitsi-turn 5349/tcp",
        "jitsi-turn 49160/udp",
        "jitsi-turn 49200/udp",
      ]),
    );
    for (const name of ["jitsi-web", "jitsi-prosody", "jitsi-jicofo"]) {
      expect(withMeet.services[name].ports, name).toBeUndefined();
    }
    expect(withMeet.services["jitsi-jvb"].environment).toMatchObject({
      JVB_ADVERTISE_IPS: "203.0.113.10",
      JVB_PORT: "10000",
    });
    expect(withMeet.services["jitsi-prosody"].environment).toMatchObject({
      TURN_HOST: "meet.example.test",
      TURN_PORT: "3478",
      TURNS_PORT: "5349",
    });
    expect(withMeet.services["jitsi-turn"].environment).toMatchObject({
      JITSI_TURN_REALM: "meet.example.test",
      JITSI_TURN_EXTERNAL_IP: "203.0.113.10",
    });
  });

  it("keeps signalling off the Internet and serves the meeting page through the edge", () => {
    expect(withMeet.networks["meet-control"].internal).toBe(true);
    expect(Object.keys(withMeet.services["jitsi-prosody"].networks)).toEqual(["meet-control"]);
    expect(Object.keys(withMeet.services["jitsi-jicofo"].networks)).toEqual(["meet-control"]);
    expect(Object.keys(withMeet.services["jitsi-web"].networks).sort()).toEqual([
      "edge",
      "meet-control",
    ]);
    expect(Object.keys(withMeet.services["jitsi-turn"].networks)).toEqual(["meet-media"]);
    expect(withMeet.services.caddy.environment).toMatchObject({
      HELIX_MEET_DOMAIN: "meet.example.test",
      HELIX_MEET_SITE: "-on",
      HELIX_JITSI_ORIGIN: "https://meet.example.test",
    });
    const site = readFileSync(join(root, "infra/caddy/optional/meet-on.caddy"), "utf8");
    expect(site).toContain("{$HELIX_MEET_DOMAIN} {");
    expect(site).toContain("tls {$HELIX_CADDY_TLS:} {");
    expect(site).toContain('"frame-ancestors https://{$HELIX_DOMAIN}"');
    expect(readFileSync(join(root, "infra/caddy/Caddyfile.production"), "utf8")).toContain(
      "import optional/meet{$HELIX_MEET_SITE:}.caddy",
    );
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
    expect(declared.length).toBeGreaterThanOrEqual(11);
    for (const name of declared) {
      expect(readFileSync(join(workspace, "secrets", name), "utf8").length, name).toBeGreaterThan(
        32,
      );
    }
    const verified = execFileSync(
      "openssl",
      [
        "verify",
        "-CAfile",
        join(workspace, "secrets", "jitsi_xmpp_ca"),
        join(workspace, "secrets", "jitsi_xmpp_cert"),
      ],
      { encoding: "utf8" },
    );
    expect(verified).toContain("OK");
    expect(() =>
      addMeetSecrets({ directory: join(workspace, "secrets"), meetHost: "meet.example.test" }),
    ).toThrow(/already holds Meet secrets/u);
  });
});
