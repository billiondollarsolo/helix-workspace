#!/usr/bin/env node
// Generate every secret file docker-compose.production.yml mounts.
//
//   node infra/scripts/generate-production-secrets.mjs --dir /srv/helix-secrets \
//     --mail-host mail.example.com
//
// Each secret is an independent random value. One private CA signs the
// internal service certificates (PostgreSQL, Redis, NATS, RustFS) and a
// placeholder certificate for inbound SMTP; its key is kept in <dir>/ca for
// renewals and should be moved offline. The script refuses to write into a
// directory that already holds secrets, so it can never rotate a live
// deployment by accident. Requires openssl.
//
// mail_smtp_password is written as a clearly marked placeholder: replace it
// with your mail provider's credential before starting Helix.
// mail_provider_webhook_secret is random; replace it if your provider issues
// its own signing secret.
//
// The optional Meet install (docker-compose.meet.yml) needs a few more files.
// Add them to an existing directory; the TURN certificate is signed by the
// same private CA until you replace it with a publicly trusted one:
//
//   node infra/scripts/generate-production-secrets.mjs --add-meet \
//     --dir /srv/helix-secrets --turn-host turn.example.com

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

/** The services run as different unprivileged users than the operator, and
 *  Compose bind-mounts these files as-is, so they must be world-readable. The
 *  directory itself is 0700: only its owner (and root) can reach them. */
const FILE_MODE = 0o644;
const CA_DAYS = 3650;
const LEAF_DAYS = 825;

export const OPERATOR_PLACEHOLDER = "REPLACE_WITH_PROVIDER_VALUE";

const randomSecret = (bytes = 48) => randomBytes(bytes).toString("base64url");

/** Issues leaf certificates from the deployment CA, working in `pki`. */
function leafIssuer(pki, caCert, caKey) {
  return (name, hosts, usage) => {
    const key = join(pki, `${name}.key`);
    const csr = join(pki, `${name}.csr`);
    const cert = join(pki, `${name}.pem`);
    const extensions = join(pki, `${name}.ext`);
    writeFileSync(
      extensions,
      [
        "basicConstraints=critical,CA:FALSE",
        `extendedKeyUsage=${usage}`,
        ...(hosts.length === 0
          ? []
          : [`subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`]),
        "",
      ].join("\n"),
    );
    openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      `/CN=${hosts[0] ?? name}`,
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      String(LEAF_DAYS),
      "-extfile",
      extensions,
    ]);
    return { key, cert };
  };
}

function installer(target) {
  return (source, name) => {
    execFileSync("cp", [source, join(target, name)]);
    chmodSync(join(target, name), FILE_MODE);
  };
}

/**
 * Adds the files docker-compose.meet.yml mounts to a directory this script
 * created earlier. Nothing that exists is replaced, so the rest of a live
 * deployment keeps its credentials.
 */
export function addMeetSecrets({ directory, turnHost }) {
  const target = resolve(directory);
  const caCert = join(target, "ca", "ca.pem");
  const caKey = join(target, "ca", "ca.key");
  if (!existsSync(caCert) || !existsSync(caKey)) {
    throw new Error(
      `${target} has no ca/ca.pem and ca/ca.key. Run this in the directory the secrets were generated in, with its CA put back.`,
    );
  }
  // LiveKit's API secret signs every meeting token; the capture secret guards
  // Helix's internal capture and recording endpoints.
  const random = ["livekit_api_secret", "meet_capture_secret"];
  const issued = ["turn_cert", "turn_key"];
  const existing = [...random, ...issued].filter((name) => existsSync(join(target, name)));
  if (existing.length > 0) {
    throw new Error(
      `${target} already holds Meet secrets (${existing.join(", ")}). Refusing to replace them.`,
    );
  }
  for (const name of random) {
    const file = join(target, name);
    writeFileSync(file, `${randomSecret()}\n`, { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
  }
  const pki = join(target, ".pki-work");
  mkdirSync(pki, { mode: 0o700 });
  try {
    // TURN over TLS (port 5349). Browsers verify this one: replace both files
    // with a publicly trusted certificate for the TURN hostname. TURN over UDP
    // on port 3478 works without it.
    const turn = leafIssuer(pki, caCert, caKey)("turn", [turnHost], "serverAuth");
    const install = installer(target);
    install(turn.cert, "turn_cert");
    install(turn.key, "turn_key");
  } finally {
    rmSync(pki, { recursive: true, force: true });
  }
  return { directory: target, files: [...random, ...issued].sort() };
}

export function generateProductionSecrets({ directory, mailHost }) {
  const target = resolve(directory);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(
      `${target} is not empty. Refusing to overwrite existing secrets; choose a new directory.`,
    );
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const write = (name, value) => {
    const file = join(target, name);
    writeFileSync(file, `${value}\n`, { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
  };
  const secret = randomSecret;

  const postgresAppPassword = secret();
  const postgresMigrationPassword = secret();
  const redisPassword = secret();
  write("postgres_password", secret());
  write("postgres_app_password", postgresAppPassword);
  write("postgres_migration_password", postgresMigrationPassword);
  write("database_url", `postgres://helix_app:${postgresAppPassword}@postgres:5432/helix`);
  write(
    "migration_database_url",
    `postgres://helix_migrator:${postgresMigrationPassword}@postgres:5432/helix`,
  );
  write("redis_password", redisPassword);
  write("redis_url", `rediss://:${redisPassword}@redis:6379`);
  write("redis_acl", `user default on >${redisPassword} ~* &* +@all`);
  write("nats_password", secret());
  write("better_auth_secret", secret());
  write("mfa_assertion_secret", secret());
  write("audit_anchor_secret", secret());
  write("rustfs_access_key", `helix${randomBytes(12).toString("hex")}`);
  write("rustfs_secret_key", secret());
  write("rustfs_kms_master_key", randomBytes(32).toString("base64"));
  write("meili_master_key", secret());
  write("searxng_secret", secret());
  write("mail_smtp_password", OPERATOR_PLACEHOLDER);
  write("mail_provider_webhook_secret", secret());

  const pki = join(target, ".pki-work");
  mkdirSync(pki, { mode: 0o700 });
  try {
    const caKey = join(pki, "ca.key");
    const caCert = join(pki, "ca.pem");
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-subj",
      "/CN=Helix deployment internal CA",
      "-days",
      String(CA_DAYS),
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    const leaf = leafIssuer(pki, caCert, caKey);
    const install = installer(target);
    for (const service of ["postgres", "redis", "nats", "rustfs"]) {
      const issued = leaf(service, [service], "serverAuth");
      install(caCert, `${service}_ca`);
      install(issued.cert, `${service}_server_cert`);
      install(issued.key, `${service}_server_key`);
    }
    // The NATS authorization maps the client certificate's CN to this user.
    const natsClient = leaf("helix_app", [], "clientAuth");
    install(natsClient.cert, "nats_client_cert");
    install(natsClient.key, "nats_client_key");
    // Inbound SMTP STARTTLS. Sending servers rarely verify this certificate;
    // replace both files with a publicly trusted one for the mail hostname
    // when you have it.
    const smtp = leaf("smtp", [mailHost], "serverAuth");
    install(smtp.cert, "smtp_tls_cert");
    install(smtp.key, "smtp_tls_key");
    // Kept only so the service certificates can be renewed. Compose never
    // mounts this folder; move it offline after the first deployment.
    const caDirectory = join(target, "ca");
    mkdirSync(caDirectory, { mode: 0o700 });
    execFileSync("cp", [caCert, join(caDirectory, "ca.pem")]);
    execFileSync("cp", [caKey, join(caDirectory, "ca.key")]);
    chmodSync(join(caDirectory, "ca.key"), 0o600);
  } finally {
    rmSync(pki, { recursive: true, force: true });
  }
  return { directory: target, files: readdirSync(target).sort() };
}

function openssl(args) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      "mail-host": { type: "string" },
      "add-meet": { type: "boolean" },
      "turn-host": { type: "string" },
    },
    strict: true,
  });
  if (values["add-meet"] === true) {
    if (values.dir === undefined || values["turn-host"] === undefined) {
      console.error(
        "Usage: generate-production-secrets.mjs --add-meet --dir <existing secrets directory> --turn-host <TURN hostname>",
      );
      process.exit(2);
    }
    try {
      const added = addMeetSecrets({ directory: values.dir, turnHost: values["turn-host"] });
      console.log(`Added ${String(added.files.length)} Meet secret files to ${added.directory}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    process.exit(0);
  }
  if (values.dir === undefined || values["mail-host"] === undefined) {
    console.error(
      "Usage: generate-production-secrets.mjs --dir <new empty directory> --mail-host <mail hostname>",
    );
    process.exit(2);
  }
  try {
    const result = generateProductionSecrets({
      directory: values.dir,
      mailHost: values["mail-host"],
    });
    console.log(`Wrote ${String(result.files.length)} secret files to ${result.directory}.`);
    console.log(
      "Next: put your mail provider's SMTP password in mail_smtp_password, then back this directory up offline.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
