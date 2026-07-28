import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const natsBoxImage = "natsio/nats-box:0.17.0";
const postgresClientImage = "postgres:17-alpine";
const redisClientImage = "redis:7-alpine";
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
  "rustfs_access_key",
  "rustfs_secret_key",
  "meili_master_key",
  "mail_smtp_password",
  "mail_provider_webhook_secret",
];

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? "pipe",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function requireSuccess(result, label) {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return result.stdout;
}

export function requireFailure(result, label) {
  if (result.error !== undefined) throw new Error(`${label} could not run`);
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded`);
  return `${result.stdout}\n${result.stderr}`;
}

export function timedScenario(evidence, name, operation) {
  const started = Date.now();
  try {
    operation();
    evidence.scenarios[name] = { status: "passed", durationMs: Date.now() - started };
  } catch (error) {
    evidence.scenarios[name] = {
      status: "failed",
      reason: error instanceof Error ? error.message : "scenario failed",
    };
    throw error;
  }
}

export function composeArgs(project, ...args) {
  return [
    "compose",
    "-p",
    project,
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.production.yml",
    ...args,
  ];
}

export function waitHealthy(environment, project, service, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = run("docker", composeArgs(project, "ps", "-q", service), {
      env: environment,
    }).stdout.trim();
    if (id.length > 0) {
      const health = run("docker", [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        id,
      ]).stdout.trim();
      if (health === "healthy") return;
      if (health === "unhealthy" || health === "exited" || health === "dead") {
        throw new Error(`${service} became ${health}`);
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`${service} did not become healthy before timeout`);
}

function writeSecret(directory, name, value) {
  writeFileSync(join(directory, name), `${value}\n`, { mode: 0o600 });
}

function generateCertificateAuthority(directory, generation) {
  const pki = join(directory, `pki-${generation}`);
  mkdirSync(pki, { mode: 0o700 });
  const caKey = join(pki, "ca.key");
  const caCert = join(pki, "ca.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-subj",
      `/CN=Helix data-plane smoke CA ${generation}`,
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { stdio: "ignore" },
  );
  return { pki, caKey, caCert };
}

function signCertificate(ca, commonName, kind) {
  const key = join(ca.pki, `${commonName}-${kind}.key`);
  const csr = join(ca.pki, `${commonName}-${kind}.csr`);
  const cert = join(ca.pki, `${commonName}-${kind}.pem`);
  const extensions = join(ca.pki, `${commonName}-${kind}.ext`);
  const extensionText =
    kind === "server"
      ? `subjectAltName=DNS:${commonName}\nextendedKeyUsage=serverAuth\n`
      : "extendedKeyUsage=clientAuth\n";
  writeFileSync(extensions, extensionText, { mode: 0o600 });
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      `/CN=${commonName}`,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca.caCert,
      "-CAkey",
      ca.caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-extfile",
      extensions,
    ],
    { stdio: "ignore" },
  );
  return { key, cert };
}

export function installPki(secretsDirectory, generation) {
  const ca = generateCertificateAuthority(secretsDirectory, generation);
  const postgres = signCertificate(ca, "postgres", "server");
  const redis = signCertificate(ca, "redis", "server");
  const nats = signCertificate(ca, "nats", "server");
  const natsClient = signCertificate(ca, "helix_app", "client");
  for (const name of ["postgres_ca", "redis_ca", "nats_ca"]) {
    copyFileSync(ca.caCert, join(secretsDirectory, name));
  }
  copyFileSync(postgres.cert, join(secretsDirectory, "postgres_server_cert"));
  copyFileSync(postgres.key, join(secretsDirectory, "postgres_server_key"));
  copyFileSync(redis.cert, join(secretsDirectory, "redis_server_cert"));
  copyFileSync(redis.key, join(secretsDirectory, "redis_server_key"));
  copyFileSync(nats.cert, join(secretsDirectory, "nats_server_cert"));
  copyFileSync(nats.key, join(secretsDirectory, "nats_server_key"));
  copyFileSync(natsClient.cert, join(secretsDirectory, "nats_client_cert"));
  copyFileSync(natsClient.key, join(secretsDirectory, "nats_client_key"));
  return ca.caCert;
}

export function prepareSecrets(directory) {
  const generic = randomBytes(48).toString("base64url");
  const postgresPassword = randomBytes(48).toString("base64url");
  const appPassword = randomBytes(48).toString("base64url");
  const migrationPassword = randomBytes(48).toString("base64url");
  const redisPassword = randomBytes(48).toString("base64url");
  const natsPassword = randomBytes(48).toString("base64url");
  for (const name of secretNames) writeSecret(directory, name, generic);
  writeSecret(directory, "postgres_password", postgresPassword);
  writeSecret(directory, "postgres_app_password", appPassword);
  writeSecret(directory, "postgres_migration_password", migrationPassword);
  writeSecret(directory, "database_url", `postgres://helix_app:${appPassword}@postgres:5432/helix`);
  writeSecret(
    directory,
    "migration_database_url",
    `postgres://helix_migrator:${migrationPassword}@postgres:5432/helix`,
  );
  writeSecret(directory, "redis_password", redisPassword);
  writeSecret(directory, "redis_url", `rediss://:${redisPassword}@redis:6379`);
  writeSecret(directory, "redis_acl", `user default on >${redisPassword} ~* &* +@all`);
  writeSecret(directory, "nats_password", natsPassword);
  const ca = installPki(directory, "initial");
  return { appPassword, migrationPassword, redisPassword, natsPassword, ca };
}

export function productionEnvironment(secretsDirectory, project) {
  return {
    ...process.env,
    HELIX_PRODUCTION_SECRETS_DIR: secretsDirectory,
    HELIX_COMPOSE_PROJECT_NAME: project,
    HELIX_DOMAIN: "workspace.example.test",
    MAIL_PROVIDER: "postmark",
    MAIL_FROM_DOMAIN: "example.test",
    MAIL_SMTP_HOST: "smtp.postmarkapp.com",
    MAIL_SMTP_USER: "provider-user",
    HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED: "true",
  };
}

export function postgresRun(network, secretsDirectory, password, sslMode, user, sql) {
  const connection = [
    "host=postgres",
    "dbname=helix",
    `user=${user}`,
    `sslmode=${sslMode}`,
    "connect_timeout=5",
    ...(sslMode === "disable" ? [] : ["sslrootcert=/certs/ca.pem"]),
  ].join(" ");
  return run("docker", [
    "run",
    "--rm",
    "--network",
    network,
    "-e",
    `PGPASSWORD=${password}`,
    "-v",
    `${join(secretsDirectory, "postgres_ca")}:/certs/ca.pem:ro`,
    postgresClientImage,
    "psql",
    connection,
    "-v",
    "ON_ERROR_STOP=1",
    "-tA",
    "-c",
    sql,
  ]);
}

export function redisRun(network, secretsDirectory, password, tls, authenticated) {
  return run("docker", [
    "run",
    "--rm",
    "--network",
    network,
    ...(authenticated ? ["-e", `REDISCLI_AUTH=${password}`] : []),
    "-v",
    `${join(secretsDirectory, "redis_ca")}:/certs/ca.pem:ro`,
    redisClientImage,
    "redis-cli",
    "-h",
    "redis",
    "-p",
    "6379",
    ...(tls ? ["--tls", "--cacert", "/certs/ca.pem"] : []),
    "ping",
  ]);
}

export function natsArgs(
  network,
  secretsDirectory,
  password,
  includeClient,
  includeAuth,
  ...command
) {
  return [
    "run",
    "--rm",
    "--network",
    network,
    "-v",
    `${join(secretsDirectory, "nats_ca")}:/certs/ca.pem:ro`,
    ...(includeClient
      ? [
          "-v",
          `${join(secretsDirectory, "nats_client_cert")}:/certs/client.pem:ro`,
          "-v",
          `${join(secretsDirectory, "nats_client_key")}:/certs/client-key.pem:ro`,
        ]
      : []),
    natsBoxImage,
    "nats",
    "--server",
    "tls://nats:4222",
    "--tlsca",
    "/certs/ca.pem",
    ...(includeClient
      ? ["--tlscert", "/certs/client.pem", "--tlskey", "/certs/client-key.pem"]
      : []),
    ...(includeAuth ? ["--user", "helix_app", "--password", password] : []),
    ...command,
  ];
}
