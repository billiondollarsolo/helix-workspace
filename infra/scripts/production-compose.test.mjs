import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let secretsDirectory;
let resolvedCompose;
let resolvedAllProfilesCompose;
let resolvedBotCompose;
let composeEnvironment;
const composeArgs = ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.production.yml"];
const promotedImages = Object.freeze({
  application:
    "ghcr.io/billiondollarsolo/helix-workspace@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  web: "ghcr.io/billiondollarsolo/helix-workspace-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  postgres:
    "ghcr.io/billiondollarsolo/helix-workspace-postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  nats: "ghcr.io/billiondollarsolo/helix-workspace-nats@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  meilisearch:
    "ghcr.io/billiondollarsolo/helix-workspace-meilisearch@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  cerbos:
    "ghcr.io/billiondollarsolo/helix-workspace-cerbos@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  spamassassin:
    "ghcr.io/billiondollarsolo/helix-workspace-spamassassin@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  clamav:
    "ghcr.io/billiondollarsolo/helix-workspace-clamav@sha256:2222222222222222222222222222222222222222222222222222222222222222",
});
const secretNames = [
  "database_url",
  "migration_database_url",
  "postgres_password",
  "postgres_app_password",
  "postgres_migration_password",
  "postgres_ca",
  "postgres_server_cert",
  "postgres_server_key",
  "redis_url",
  "redis_acl",
  "redis_password",
  "redis_ca",
  "redis_server_cert",
  "redis_server_key",
  "nats_password",
  "nats_ca",
  "nats_server_cert",
  "nats_server_key",
  "nats_client_cert",
  "nats_client_key",
  "better_auth_secret",
  "mfa_assertion_secret",
  "rustfs_access_key",
  "rustfs_secret_key",
  "meili_master_key",
  "mail_smtp_password",
  "mail_provider_webhook_secret",
];
beforeAll(() => {
  secretsDirectory = mkdtempSync(join(tmpdir(), "helix-production-compose-"));
  const envFile = join(secretsDirectory, "empty.env");
  writeFileSync(envFile, "");
  const generatedSecret = "D7y9xP3vL6qR2sT8uW4aC5fG0hJ1kM7nB9zX3";
  for (const name of secretNames) {
    writeFileSync(join(secretsDirectory, name), generatedSecret, { mode: 0o600 });
  }
  writeFileSync(
    join(secretsDirectory, "database_url"),
    `postgres://helix_app:${generatedSecret}@postgres:5432/helix`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(secretsDirectory, "migration_database_url"),
    `postgres://helix_migrator:${generatedSecret}@postgres:5432/helix`,
    { mode: 0o600 },
  );
  writeFileSync(join(secretsDirectory, "redis_url"), `rediss://:${generatedSecret}@redis:6379`, {
    mode: 0o600,
  });
  writeFileSync(
    join(secretsDirectory, "redis_acl"),
    `user default on >${generatedSecret} ~* &* +@all`,
    { mode: 0o600 },
  );
  composeEnvironment = {
    ...process.env,
    HELIX_PRODUCTION_SECRETS_DIR: secretsDirectory,
    HELIX_IMAGE: promotedImages.application,
    HELIX_WEB_IMAGE: promotedImages.web,
    HELIX_POSTGRES_IMAGE: promotedImages.postgres,
    HELIX_NATS_IMAGE: promotedImages.nats,
    HELIX_MEILISEARCH_IMAGE: promotedImages.meilisearch,
    HELIX_CERBOS_IMAGE: promotedImages.cerbos,
    HELIX_SPAMD_IMAGE: promotedImages.spamassassin,
    HELIX_CLAMAV_IMAGE: promotedImages.clamav,
    HELIX_DOMAIN: "workspace.example.test",
    HELIX_FEDERATION_NETWORK: "organization-federation",
    HELIX_REGION: "eu-test",
    HELIX_DEFAULT_ORG_NAME: "Example Workspace",
    CADDY_HTTP_PORT: "80",
    CADDY_HTTPS_PORT: "443",
    HELIX_SMTP_RECEIVE_PORT: "25",
    HELIX_MFA_ASSERTION_ISSUER: "https://auth.example.test",
    HELIX_MFA_ASSERTION_AUDIENCE: "helix-workspace",
    MAIL_PROVIDER: "postmark",
    MAIL_FROM_DOMAIN: "example.test",
    MAIL_SMTP_HOST: "smtp.postmarkapp.com",
    MAIL_SMTP_USER: "provider-user",
    HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED: "true",
  };
  const resolveCompose = (extraArgs = []) =>
    JSON.parse(
      execFileSync(
        "docker",
        [...composeArgs, "--env-file", envFile, ...extraArgs, "config", "--format", "json"],
        {
          cwd: root,
          encoding: "utf8",
          env: composeEnvironment,
        },
      ),
    );
  resolvedCompose = resolveCompose();
  resolvedAllProfilesCompose = resolveCompose(["--profile", "*"]);
  resolvedBotCompose = resolveCompose(["-f", "docker-compose.agentspace.yml"]);
});
afterAll(() => {
  if (secretsDirectory !== undefined) {
    rmSync(secretsDirectory, { recursive: true, force: true });
  }
});
describe("production Compose overlay", () => {
  it("joins Agentspace through only the API and signed-storage edge, keeping data services private", () => {
    expect(resolvedCompose.networks["app-federation"]).toBeUndefined();
    expect(resolvedBotCompose.networks["app-federation"]).toMatchObject({
      name: "organization-federation",
      external: true,
    });
    expect(resolvedBotCompose.services.helix.networks["app-federation"].aliases).toEqual([
      "helix-workspace",
    ]);
    expect(resolvedBotCompose.services.caddy.networks["app-federation"].aliases).toEqual([
      "workspace.example.test",
    ]);
    for (const [name, service] of Object.entries(resolvedBotCompose.services)) {
      if (name !== "helix" && name !== "caddy")
        expect(service.networks?.["app-federation"]).toBeUndefined();
      for (const [network, settings] of Object.entries(
        resolvedCompose.services[name].networks ?? {},
      ))
        expect(service.networks?.[network]).toEqual(settings);
      expect(service.ports).toEqual(resolvedCompose.services[name].ports);
    }
    expect(resolvedBotCompose.services.helix.environment).toEqual(
      resolvedCompose.services.helix.environment,
    );
  });
  it("publishes only Caddy HTTP/HTTPS and inbound SMTP", () => {
    const published = Object.entries(resolvedAllProfilesCompose.services).flatMap(
      ([service, config]) =>
        (config.ports ?? []).map((port) => ({
          service,
          target: port.target,
          published: Number(port.published),
          protocol: port.protocol,
        })),
    );
    expect(published).toEqual([
      { service: "caddy", target: 80, published: 80, protocol: "tcp" },
      { service: "caddy", target: 443, published: 443, protocol: "tcp" },
      { service: "caddy", target: 443, published: 443, protocol: "udp" },
      { service: "helix", target: 2525, published: 25, protocol: "tcp" },
    ]);
  });
  it("has no file conversion service or network", () => {
    expect(resolvedAllProfilesCompose.services["drive-preview-libreoffice"]).toBeUndefined();
    expect(resolvedCompose.networks["content-conversion"]).toBeUndefined();
  });
  it("keeps every data-plane and admin service private", () => {
    for (const service of [
      "postgres",
      "redis",
      "nats",
      "meilisearch",
      "rustfs",
      "cerbos",
      "spamd",
      "clamav",
    ]) {
      expect(resolvedCompose.services[service].ports).toBeUndefined();
      expect(resolvedCompose.services[service].networks).toHaveProperty("data-plane");
    }
    // The scanners download signature and rule updates; without egress the
    // signatures go stale and Helix reports not ready.
    const scannerNetworks = { "data-plane": null, "scanner-updates-egress": null };
    expect(resolvedCompose.services.clamav.networks).toEqual(scannerNetworks);
    expect(resolvedCompose.services.spamd.networks).toEqual(scannerNetworks);
    expect(resolvedCompose.networks["scanner-updates-egress"].internal).not.toBe(true);
    expect(resolvedCompose.services.clamav.environment.CLAMD_CONF_SelfCheck).toBe("60");
    // Caddy forwards signed object requests to RustFS over `edge`; nothing is published.
    expect(resolvedCompose.services.rustfs.networks).toEqual({ "data-plane": null, edge: null });
    expect(resolvedCompose.networks["data-plane"].internal).toBe(true);
  });
  it("boots the application against TLS object storage with KMS, object lock and audit copies", () => {
    const environment = resolvedCompose.services.helix.environment;
    expect(environment).toMatchObject({
      HELIX_REGION: "eu-test",
      HELIX_DEFAULT_ORG_NAME: "Example Workspace",
      RUSTFS_ENDPOINT: "https://rustfs:9000",
      RUSTFS_PUBLIC_ENDPOINT: "https://workspace.example.test",
      RUSTFS_REGION: "eu-test",
      RUSTFS_SERVER_SIDE_ENCRYPTION: "aws:kms",
      RUSTFS_SSE_KMS_KEY_ID: "helix-default",
      RUSTFS_OBJECT_LOCK_MODE: "GOVERNANCE",
      NODE_EXTRA_CA_CERTS: "/run/secrets/rustfs_ca",
      MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY: "starttls",
      MAIL_SMTP_RECEIVER_TLS_CERT_FILE: "/run/secrets/smtp_tls_cert",
      MAIL_SMTP_RECEIVER_TLS_KEY_FILE: "/run/secrets/smtp_tls_key",
      AUDIT_IMMUTABLE_S3_ENABLED: "true",
      AUDIT_IMMUTABLE_S3_REGION: "eu-test",
      AUDIT_IMMUTABLE_S3_ANCHOR_SECRET_FILE: "/run/secrets/audit_anchor_secret",
      MEET_JITSI_ENABLED: "false",
    });
    // Development Meet defaults from the base file must not reach production.
    expect(environment).not.toHaveProperty("MEET_JITSI_PUBLIC_URL");
    expect(environment).not.toHaveProperty("MEET_JITSI_DOMAIN");
    expect(resolvedCompose.services["helix-migrate"].environment.HELIX_REGION).toBe("eu-test");
    // First boot waits for ClamAV to load current signatures instead of failing.
    expect(resolvedCompose.services.helix.healthcheck.start_period).toBe("10m0s");
    expect(resolvedCompose.services.helix.depends_on["helix-storage-init"].condition).toBe(
      "service_completed_successfully",
    );
    const rustfs = resolvedCompose.services.rustfs;
    expect(rustfs.environment).toMatchObject({
      RUSTFS_TLS_PATH: "/tmp/tls",
      RUSTFS_KMS_ENABLE: "true",
      RUSTFS_KMS_BACKEND: "local",
      RUSTFS_KMS_KEY_DIR: "/kms",
      RUSTFS_REGION: "eu-test",
    });
    expect(rustfs.environment).not.toHaveProperty("RUSTFS_KMS_LOCAL_MASTER_KEY");
    expect(rustfs.entrypoint.join("\n")).toContain("cat /run/secrets/rustfs_kms_master_key");
    expect(resolvedCompose.services["rustfs-kms-key"].entrypoint.join("\n")).toContain(
      "/rustfs/admin/v3/kms/key/create",
    );
    expect(resolvedCompose.services["helix-storage-init"].entrypoint).toEqual([
      "/nodejs/bin/node",
      "dist/db/provision-object-store.js",
    ]);
    const caddy = resolvedCompose.services.caddy;
    expect(caddy.environment).toMatchObject({ XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/config" });
    expect(caddy.healthcheck.test).toContain("http://127.0.0.1:8081/healthz");
  });
  it("removes Mailpit from active production and Helix dependencies", () => {
    expect(resolvedCompose.services.mailpit).toBeUndefined();
    expect(resolvedCompose.services.helix.depends_on).not.toHaveProperty("mailpit");
    expect(resolvedCompose.services.helix.depends_on).toHaveProperty("spamd");
    expect(resolvedCompose.services.helix.depends_on).toHaveProperty("clamav");
  });
  it("keeps SearXNG optional, private, secret-backed, and able to reach search engines", () => {
    expect(resolvedCompose.services.searxng).toBeUndefined();
    expect(resolvedCompose.services.helix.depends_on).not.toHaveProperty("searxng");
    const service = resolvedAllProfilesCompose.services.searxng;
    expect(service.profiles).toEqual(["web-search"]);
    expect(service.ports).toBeUndefined();
    expect(service.networks).toEqual({ "data-plane": null, "web-search-egress": null });
    expect(resolvedAllProfilesCompose.networks["web-search-egress"].internal).not.toBe(true);
    expect(service.environment).not.toHaveProperty("SEARXNG_SECRET");
    expect(service.secrets).toEqual([
      { source: "searxng_secret", target: "/run/secrets/searxng_secret" },
    ]);
    expect(service.entrypoint.join("\n")).toContain("cat /run/secrets/searxng_secret");
    expect(service.entrypoint.join("\n")).toContain('"$${#SEARXNG_SECRET}" -lt 32');
    expect(service.security_opt).toContain("no-new-privileges:true");
    expect(service.deploy.resources.limits).toMatchObject({
      cpus: 1,
      memory: "536870912",
      pids: 256,
    });
  });
  it("keeps the password manager optional, private, and on its own hostname", () => {
    // Not installed: no service, no site, and the application advertises no link.
    expect(resolvedCompose.services.vaultwarden).toBeUndefined();
    expect(resolvedCompose.services.helix.depends_on).not.toHaveProperty("vaultwarden");
    expect(resolvedCompose.services.helix.environment.HELIX_PASSWORDS_URL).toBe("");
    expect(resolvedCompose.services.caddy.environment.HELIX_PASSWORDS_SITE).toBe("");

    const installed = JSON.parse(
      execFileSync(
        "docker",
        [...composeArgs, "--profile", "passwords", "config", "--format", "json"],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...composeEnvironment, HELIX_PASSWORDS_DOMAIN: "vault.example.test" },
        },
      ),
    );
    expect(installed.services.helix.environment.HELIX_PASSWORDS_URL).toBe(
      "https://vault.example.test",
    );
    expect(installed.services.caddy.environment).toMatchObject({
      HELIX_PASSWORDS_DOMAIN: "vault.example.test",
      HELIX_PASSWORDS_SITE: "-on",
    });
    const service = installed.services.vaultwarden;
    expect(service.profiles).toEqual(["passwords"]);
    expect(service.image).toMatch(/^vaultwarden\/server:[\d.]+-alpine@sha256:[a-f0-9]{64}$/u);
    expect(service.ports).toBeUndefined();
    expect(service.networks).toEqual({ edge: null });
    expect(service.environment).toMatchObject({
      DOMAIN: "https://vault.example.test",
      SIGNUPS_VERIFY: "true",
      SIGNUPS_DOMAINS_WHITELIST: "example.test",
      DISABLE_ICON_DOWNLOAD: "true",
      SMTP_HOST: "smtp.postmarkapp.com",
      SMTP_SECURITY: "starttls",
      SMTP_PASSWORD_FILE: "/run/secrets/mail_smtp_password",
    });
    // No server administration page, and no secret in the environment.
    expect(service.environment).not.toHaveProperty("ADMIN_TOKEN");
    expect(service.environment).not.toHaveProperty("SMTP_PASSWORD");
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toContain("no-new-privileges:true");
    expect(service.deploy.resources.limits).toMatchObject({ cpus: 1, pids: 256 });

    const site = readFileSync(join(root, "infra/caddy/optional/passwords-on.caddy"), "utf8");
    expect(site).toContain("{$HELIX_PASSWORDS_DOMAIN} {");
    expect(site).toContain("tls {$HELIX_CADDY_TLS:} {");
    expect(site).toContain("header_up -X-Helix-Mfa-Verified");
    expect(readFileSync(join(root, "infra/caddy/Caddyfile.production"), "utf8")).toContain(
      "import optional/passwords{$HELIX_PASSWORDS_SITE:}.caddy",
    );
    // The file imported when nothing is installed defines no site.
    expect(
      readFileSync(join(root, "infra/caddy/optional/passwords.caddy"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#")),
    ).toEqual([]);
  });
  it("uses the exact reviewed production dependency image inventory and waits for readiness", () => {
    expect(
      Object.fromEntries(
        ["postgres", "redis", "nats", "meilisearch", "rustfs", "cerbos", "spamd", "clamav"].map(
          (service) => [service, resolvedCompose.services[service].image],
        ),
      ),
    ).toEqual({
      postgres: promotedImages.postgres,
      redis:
        "redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0",
      nats: promotedImages.nats,
      meilisearch: promotedImages.meilisearch,
      rustfs:
        "rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c",
      cerbos: promotedImages.cerbos,
      spamd: promotedImages.spamassassin,
      clamav: promotedImages.clamav,
    });
    expect(resolvedCompose.services.clamav.platform).toBe("linux/amd64");
    for (const dependency of [
      "postgres",
      "redis",
      "nats",
      "meilisearch",
      "rustfs",
      "cerbos",
      "spamd",
      "clamav",
    ]) {
      expect(resolvedCompose.services[dependency].healthcheck).toBeDefined();
      expect(resolvedCompose.services.helix.depends_on[dependency].condition).toBe(
        "service_healthy",
      );
    }
  });
  it("uses mounted file-backed application secrets without inline fallbacks", () => {
    const environment = resolvedCompose.services.helix.environment;
    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.REDIS_URL).toBeUndefined();
    expect(environment.NATS_PASSWORD).toBeUndefined();
    expect(environment.BETTER_AUTH_SECRET).toBeUndefined();
    expect(environment.HELIX_MFA_ASSERTION_SECRET).toBeUndefined();
    expect(environment.RUSTFS_SECRET_KEY).toBeUndefined();
    expect(environment.MEILI_MASTER_KEY).toBeUndefined();
    expect(environment.MAIL_SMTP_PASS).toBeUndefined();
    expect(environment.MAIL_PROVIDER_WEBHOOK_SECRET).toBeUndefined();
    expect(environment.DATABASE_URL_FILE).toBe("/run/secrets/database_url");
    expect(environment.REDIS_URL_FILE).toBe("/run/secrets/redis_url");
    expect(environment.NATS_PASSWORD_FILE).toBe("/run/secrets/nats_password");
    expect(environment.BETTER_AUTH_SECRET_FILE).toBe("/run/secrets/better_auth_secret");
    expect(environment.HELIX_MFA_ASSERTION_SECRET_FILE).toBe("/run/secrets/mfa_assertion_secret");
    expect(environment.HELIX_MFA_ASSERTION_ISSUER).toBe("https://auth.example.test");
    expect(environment.HELIX_MFA_ASSERTION_AUDIENCE).toBe("helix-workspace");
    expect(environment.MAIL_SMTP_PASS_FILE).toBe("/run/secrets/mail_smtp_password");
  });
  it("runs migrations as a separate one-shot job with a distinct credential", () => {
    const migration = resolvedCompose.services["helix-migrate"];
    const helix = resolvedCompose.services.helix;
    expect(migration.entrypoint).toEqual(["/nodejs/bin/node", "dist/db/migrate.js"]);
    expect(migration.environment).toMatchObject({
      NODE_ENV: "production",
      DATABASE_URL_FILE: "/run/secrets/migration_database_url",
      POSTGRES_POOL_MAX: "1",
    });
    expect(migration.environment.DATABASE_URL).toBeUndefined();
    expect(migration.restart).toBe("no");
    expect(migration.read_only).toBe(true);
    expect(migration.user).toBe("10001:10001");
    expect(migration.networks).toEqual({ "data-plane": null });
    expect(migration.ports).toBeUndefined();
    expect(migration.secrets).toEqual(
      expect.arrayContaining([
        {
          source: "migration_database_url",
          target: "/run/secrets/migration_database_url",
        },
        {
          source: "postgres_ca",
          target: "/run/secrets/postgres_ca",
        },
      ]),
    );
    expect(helix.depends_on["helix-migrate"].condition).toBe("service_completed_successfully");
    expect(helix.secrets.map((secret) => secret.source)).not.toContain("migration_database_url");
  });
  it("enables real Mail and Drive scanning in the Business fixture", () => {
    const environment = resolvedCompose.services.helix.environment;
    expect(environment.HELIX_SECURITY_TIER).toBe("business");
    expect(environment.MAIL_SPAMD_ENABLED).toBe("true");
    expect(environment.MAIL_SPAMD_HOST).toBe("spamd");
    expect(environment.MAIL_CLAMAV_ENABLED).toBe("true");
    expect(environment.MAIL_CLAMAV_HOST).toBe("clamav");
    expect(environment.DRIVE_CLAMAV_ENABLED).toBe("true");
    expect(environment.DRIVE_CLAMAV_HOST).toBe("clamav");
    expect(environment.DRIVE_CLAMAV_MAX_BYTES).toBe("1073741824");
    expect(resolvedCompose.services.clamav.healthcheck).toBeDefined();
  });
  it("requires encrypted authenticated data-plane connections", () => {
    const helixEnvironment = resolvedCompose.services.helix.environment;
    expect(helixEnvironment.POSTGRES_TLS_CA_FILE).toBe("/run/secrets/postgres_ca");
    expect(helixEnvironment.REDIS_URL_FILE).toBe("/run/secrets/redis_url");
    expect(helixEnvironment.REDIS_TLS_CA_FILE).toBe("/run/secrets/redis_ca");
    expect(helixEnvironment.NATS_URL).toBe("tls://nats:4222");
    expect(helixEnvironment.NATS_USER).toBe("helix_app");
    expect(helixEnvironment.NATS_TLS_CA_FILE).toBe("/run/secrets/nats_ca");
    expect(helixEnvironment.NATS_TLS_CERT_FILE).toBe("/run/secrets/nats_client_cert");
    expect(helixEnvironment.NATS_TLS_KEY_FILE).toBe("/run/secrets/nats_client_key");
    const postgres = resolvedCompose.services.postgres;
    // Only the TLS bootstrap starts as root; docker-entrypoint.sh drops to postgres.
    expect(postgres.user).toBe("0:0");
    expect(postgres.entrypoint.join(" ")).toContain("exec docker-entrypoint.sh postgres");
    for (const service of ["nats", "meilisearch", "cerbos", "spamd", "clamav"]) {
      expect(resolvedCompose.services[service].user, `${service} image user`).toBeUndefined();
    }
    expect(postgres.entrypoint.join(" ")).toContain("ssl=on");
    expect(postgres.entrypoint.join(" ")).toContain("hostnossl all all 0.0.0.0/0 reject");
    expect(postgres.secrets.map((secret) => secret.source)).toEqual(
      expect.arrayContaining([
        "postgres_app_password",
        "postgres_migration_password",
        "postgres_ca",
        "postgres_server_cert",
        "postgres_server_key",
      ]),
    );
    const redis = resolvedCompose.services.redis;
    expect(redis.command).toEqual(
      expect.arrayContaining([
        "--port",
        "0",
        "--tls-port",
        "6379",
        "--aclfile",
        "/run/secrets/redis_acl",
      ]),
    );
    expect(redis.healthcheck.test.join(" ")).toContain("REDISCLI_AUTH");
    const nats = resolvedCompose.services.nats;
    expect(nats.entrypoint.join(" ")).toContain("nats-server.production.conf");
    const natsConfig = readFileSync(join(root, "infra/nats/nats-server.production.conf"), "utf8");
    expect(natsConfig).toContain('publish: ["helix.>"]');
    expect(natsConfig).toContain('subscribe: ["helix.>"]');
    expect(natsConfig).toContain("verify: true");
  });
  it("packages only the approved core Workspace MVP modules", () => {
    const environment = resolvedCompose.services.helix.environment;
    expect(environment.HELIX_APPS).toBe("mail,drive,chat,assistant");
    expect(JSON.parse(environment.HELIX_CONFIG_JSON).modules).toMatchObject({
      calendar: { enabled: false },
      meet: { enabled: false },
    });
  });
  it("pulls only immutable promoted Workspace images in production", () => {
    const helix = resolvedCompose.services.helix;
    expect(helix.image).toBe(promotedImages.application);
    expect(helix.build).toBeUndefined();
    expect(helix.pull_policy).toBe("always");
    expect(resolvedCompose.services["helix-migrate"].image).toBe(promotedImages.application);
    expect(resolvedCompose.services["helix-migrate"].build).toBeUndefined();
    const caddy = resolvedCompose.services.caddy;
    expect(caddy.image).toBe(promotedImages.web);
    expect(caddy.build).toBeUndefined();
    expect(caddy.pull_policy).toBe("always");
    for (const service of ["postgres", "nats", "meilisearch", "cerbos", "spamd"]) {
      expect(resolvedCompose.services[service].build).toBeUndefined();
      expect(resolvedCompose.services[service].pull_policy).toBe("always");
      expect(resolvedCompose.services[service].image).toMatch(
        /^ghcr[.]io\/billiondollarsolo\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/u,
      );
    }
  });
  it("fails closed when a promoted image digest is omitted", () => {
    const environment = { ...composeEnvironment };
    delete environment.HELIX_CERBOS_IMAGE;
    expect(() =>
      execFileSync("docker", [...composeArgs, "config", "--quiet"], {
        cwd: root,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow(/HELIX_CERBOS_IMAGE/u);
  });
  it("limits the runtime payload to compiled application output", () => {
    const appPackage = JSON.parse(readFileSync(join(root, "apps/helix/package.json"), "utf8"));
    const dockerfile = readFileSync(join(root, "infra/docker/Dockerfile"), "utf8");
    expect(appPackage.files).toEqual(["dist"]);
    expect(dockerfile).toContain("pnpm --filter @helix/app... run build");
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]');
    expect(dockerfile).not.toContain("--legacy");
  });
  it("applies supported container hardening and resource limits", () => {
    const helix = resolvedCompose.services.helix;
    expect(helix.read_only).toBe(true);
    expect(helix.user).toBe("10001:10001");
    expect(helix.cap_drop).toContain("ALL");
    expect(helix.security_opt).toContain("no-new-privileges:true");
    expect(helix.tmpfs).toBeDefined();
    expect(helix.ulimits.nofile).toEqual({ soft: 8192, hard: 16384 });
    expect(helix.deploy.resources.limits).toMatchObject({
      cpus: 2,
      memory: "2147483648",
      pids: 512,
    });
    const caddy = resolvedCompose.services.caddy;
    expect(caddy.read_only).toBe(true);
    expect(caddy.user).toBe("10001:10001");
    expect(caddy.ulimits.nofile).toEqual({ soft: 1024, hard: 4096 });
    expect(caddy.deploy.resources.limits.pids).toBe(128);
    const migrator = resolvedCompose.services["helix-migrate"];
    expect(migrator.ulimits.nofile).toEqual({ soft: 1024, hard: 4096 });
    expect(migrator.deploy.resources.limits.pids).toBe(128);
    expect(resolvedCompose.services.cerbos.read_only).toBe(true);
  });
  it("lets Helix hand an uploaded certificate to the edge over a private socket", () => {
    const { helix, caddy } = resolvedCompose.services;
    const init = resolvedCompose.services["edge-volumes-init"];
    const mounts = (service) =>
      Object.fromEntries(
        service.volumes.map((volume) => [
          volume.source,
          { target: volume.target, readOnly: volume.read_only === true },
        ]),
      );

    expect(helix.environment).toMatchObject({
      HELIX_EDGE_TLS_SOURCE: "automatic",
      HELIX_EDGE_CERT_DIR: "/run/helix-edge-certs",
      HELIX_EDGE_ADMIN_SOCKET: "/run/caddy-admin/admin.sock",
      HELIX_EDGE_PROBE_ADDRESS: "caddy:443",
    });
    // A Unix socket in a volume only these two services mount: no admin port.
    expect(caddy.environment.HELIX_CADDY_ADMIN).toBe("unix//run/caddy-admin/admin.sock");
    expect(mounts(helix)).toMatchObject({
      "edge-certs": { target: "/run/helix-edge-certs", readOnly: false },
      "caddy-admin": { target: "/run/caddy-admin", readOnly: false },
    });
    // The edge only reads certificates; Helix is the one writer.
    expect(mounts(caddy)).toMatchObject({
      "edge-certs": { target: "/run/helix-edge-certs", readOnly: true },
      "caddy-admin": { target: "/run/caddy-admin", readOnly: false },
    });
    const sharers = Object.entries(resolvedCompose.services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) =>
          ["edge-certs", "caddy-admin"].includes(volume.source),
        ),
      )
      .map(([name]) => name)
      .sort();
    expect(sharers).toEqual(["caddy", "edge-volumes-init", "helix"]);
    expect(init.network_mode).toBe("none");
    expect(init.restart).toBe("no");
    expect(helix.depends_on["edge-volumes-init"].condition).toBe("service_completed_successfully");
    expect(caddy.depends_on["edge-volumes-init"].condition).toBe("service_completed_successfully");
  });

  it("serves the SPA and proxies only explicit backend paths at the production edge", () => {
    const caddyfile = readFileSync(join(root, "infra/caddy/Caddyfile.production"), "utf8");
    // The admin endpoint stays off unless a deployment mounts its private socket.
    expect(caddyfile).toContain("admin {$HELIX_CADDY_ADMIN:off}");
    expect(caddyfile).not.toMatch(/admin\s+(?:localhost|0\.0\.0\.0|:)\S*/u);
    // An uploaded certificate is loaded from the folder Helix writes.
    expect(caddyfile).toContain("load {$HELIX_EDGE_CERT_DIR:/run/helix-edge-certs}");
    // Certificate source is a switch; the default is automatic HTTPS.
    expect(caddyfile).toContain("tls {$HELIX_CADDY_TLS:} {");
    // Only the bucket path reaches the object store, with the signed Host kept
    // and the deployment CA pinned.
    expect(caddyfile).toContain("@objects path /{$HELIX_STORAGE_BUCKET:helix-objects}/*");
    expect(caddyfile).toContain("header_up Host {host}");
    expect(caddyfile).toContain(
      "tls_trust_pool file {$HELIX_STORAGE_CA_FILE:/run/secrets/rustfs_ca}",
    );
    expect(caddyfile).toContain("root * /srv");
    expect(caddyfile).toContain("try_files {path} /index.html");
    expect(caddyfile).toContain("file_server");
    expect(caddyfile).toContain("/api/*");
    expect(caddyfile).toContain("/ws/*");
    expect(caddyfile).not.toMatch(/path[^\n]*\/rustfs/u);
    expect(caddyfile).not.toContain("/cerbos");
    expect(caddyfile).not.toContain("/metrics");
    expect(caddyfile.match(/header_up -X-Helix-Mfa-Verified/gu)).toHaveLength(4);
  });
});
