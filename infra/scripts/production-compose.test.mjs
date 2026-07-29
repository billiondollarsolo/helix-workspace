import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let secretsDirectory;
let resolvedCompose;
let resolvedAllProfilesCompose;

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

  const composeEnvironment = {
    ...process.env,
    HELIX_PRODUCTION_SECRETS_DIR: secretsDirectory,
    HELIX_DOMAIN: "workspace.example.test",
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
  const composeArgs = [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.production.yml",
  ];
  const resolveCompose = (extraArgs = []) =>
    JSON.parse(
      execFileSync("docker", [...composeArgs, ...extraArgs, "config", "--format", "json"], {
        cwd: root,
        encoding: "utf8",
        env: composeEnvironment,
      }),
    );
  resolvedCompose = resolveCompose();
  resolvedAllProfilesCompose = resolveCompose(["--profile", "*"]);
});

afterAll(() => {
  if (secretsDirectory !== undefined) {
    rmSync(secretsDirectory, { recursive: true, force: true });
  }
});

describe("production Compose overlay", () => {
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

  it("keeps every data-plane and admin service private", () => {
    for (const service of [
      "postgres",
      "redis",
      "nats",
      "meilisearch",
      "rustfs",
      "cerbos",
      "clamav",
    ]) {
      expect(resolvedCompose.services[service].ports).toBeUndefined();
      expect(resolvedCompose.services[service].networks).toHaveProperty("data-plane");
    }
    expect(resolvedCompose.services.clamav.networks).toEqual({ "data-plane": null });
    expect(resolvedCompose.networks["data-plane"].internal).toBe(true);
  });

  it("removes Mailpit from active production and Helix dependencies", () => {
    expect(resolvedCompose.services.mailpit).toBeUndefined();
    expect(resolvedCompose.services.helix.depends_on).not.toHaveProperty("mailpit");
    expect(resolvedCompose.services.helix.depends_on).toHaveProperty("clamav");
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
      HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
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
    expect(environment.HELIX_EDITORS_MIGRATIONS_ENABLED).toBe("false");
    expect(JSON.parse(environment.HELIX_CONFIG_JSON).modules).toMatchObject({
      docs: { enabled: false },
      calendar: { enabled: false },
      meet: { enabled: false },
      editors: { enabled: false },
    });
  });

  it("builds the reviewed non-root Workspace images with the paired package context", () => {
    const helix = resolvedCompose.services.helix;
    expect(helix.image).toBe("helix/workspace:production");
    expect(helix.build.context).toBe(root);
    expect(helix.build.dockerfile).toBe("infra/docker/Dockerfile");
    expect(helix.build.target).toBe("runtime");
    expect(helix.build.additional_contexts.helix_editors).toBe(resolve(root, "../helix-editors"));

    const caddy = resolvedCompose.services.caddy;
    expect(caddy.image).toBe("helix/workspace-web:production");
    expect(caddy.build.context).toBe(root);
    expect(caddy.build.dockerfile).toBe("infra/docker/Dockerfile");
    expect(caddy.build.target).toBe("web-runtime");
    expect(caddy.build.additional_contexts.helix_editors).toBe(resolve(root, "../helix-editors"));
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

  it("serves the SPA and proxies only explicit backend paths at the production edge", () => {
    const caddyfile = readFileSync(join(root, "infra/caddy/Caddyfile.production"), "utf8");
    expect(caddyfile).toContain("admin off");
    expect(caddyfile).toContain("root * /srv");
    expect(caddyfile).toContain("try_files {path} /index.html");
    expect(caddyfile).toContain("file_server");
    expect(caddyfile).toContain("/api/*");
    expect(caddyfile).toContain("/ws/*");
    expect(caddyfile).not.toContain("/rustfs");
    expect(caddyfile).not.toContain("/cerbos");
    expect(caddyfile).not.toContain("/metrics");
    expect(caddyfile.match(/header_up -X-Helix-Mfa-Verified/gu)).toHaveLength(2);
  });
});
