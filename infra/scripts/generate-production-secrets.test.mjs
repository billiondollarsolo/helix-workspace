import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateProductionSecrets, OPERATOR_PLACEHOLDER } from "./generate-production-secrets.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** Secret names declared by a Compose file's top-level `secrets:` block. */
function declaredSecrets(compose) {
  const block = compose.slice(compose.lastIndexOf("\nsecrets:\n"));
  return [...block.matchAll(/^ {2}([a-z0-9_]+):\n {4}file: /gmu)].map((match) => match[1]);
}

describe("production secrets generator", () => {
  const workspace = mkdtempSync(join(tmpdir(), "helix-secrets-test-"));
  const directory = join(workspace, "secrets");
  const result = generateProductionSecrets({ directory, mailHost: "mail.example.test" });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it("writes every secret file the production Compose overlay mounts", () => {
    const required = declaredSecrets(read("docker-compose.production.yml"));
    expect(required.length).toBeGreaterThan(25);
    expect(required.filter((name) => !result.files.includes(name))).toEqual([]);
  });

  it("leaves the certificate files of the bring-your-own-certificate overlay to the operator", () => {
    const operatorProvided = declaredSecrets(read("docker-compose.tls-files.yml"));
    expect(operatorProvided).toEqual(["tls_cert", "tls_key"]);
    expect(result.files.filter((name) => operatorProvided.includes(name))).toEqual([]);
  });

  it("gives each secret its own value and marks the provider password as a placeholder", () => {
    const value = (name) => readFileSync(join(directory, name), "utf8").trim();
    const random = [
      "better_auth_secret",
      "mfa_assertion_secret",
      "audit_anchor_secret",
      "nats_password",
    ];
    expect(new Set(random.map(value)).size).toBe(random.length);
    for (const name of random) expect(value(name).length).toBeGreaterThanOrEqual(32);
    expect(value("mail_smtp_password")).toBe(OPERATOR_PLACEHOLDER);
    expect(value("database_url")).toContain(value("postgres_app_password"));
    expect(value("redis_url")).toContain(value("redis_password"));
  });

  it("issues service certificates the deployment CA verifies, for the hostnames the services use", () => {
    for (const service of ["postgres", "redis", "nats", "rustfs"]) {
      const verified = execFileSync(
        "openssl",
        [
          "verify",
          "-CAfile",
          join(directory, `${service}_ca`),
          join(directory, `${service}_server_cert`),
        ],
        { encoding: "utf8" },
      );
      expect(verified).toContain(": OK");
      const names = execFileSync(
        "openssl",
        [
          "x509",
          "-in",
          join(directory, `${service}_server_cert`),
          "-noout",
          "-ext",
          "subjectAltName",
        ],
        { encoding: "utf8" },
      );
      expect(names).toContain(`DNS:${service}`);
    }
    const smtp = execFileSync(
      "openssl",
      ["x509", "-in", join(directory, "smtp_tls_cert"), "-noout", "-ext", "subjectAltName"],
      { encoding: "utf8" },
    );
    expect(smtp).toContain("DNS:mail.example.test");
  });

  it("locks the directory down and keeps the CA key out of the mounted files", () => {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(directory, "ca")).sort()).toEqual(["ca.key", "ca.pem"]);
    expect(statSync(join(directory, "ca", "ca.key")).mode & 0o777).toBe(0o600);
    expect(declaredSecrets(read("docker-compose.production.yml"))).not.toContain("ca");
  });

  it("refuses to overwrite an existing secrets directory", () => {
    expect(() => generateProductionSecrets({ directory, mailHost: "mail.example.test" })).toThrow(
      "Refusing to overwrite",
    );
  });

  it("keeps mounted secrets readable by container users under a restrictive operator umask", () => {
    const privateDirectory = join(workspace, "private-umask");
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `process.umask(0o077);
       const { generateProductionSecrets, addMeetSecrets } = await import(process.argv[1]);
       generateProductionSecrets({ directory: process.argv[2], mailHost: "mail.example.test" });
       addMeetSecrets({ directory: process.argv[2], meetHost: "meet.example.test" });`,
      new URL("./generate-production-secrets.mjs", import.meta.url).href,
      privateDirectory,
    ]);
    expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(privateDirectory, "ca", "ca.key")).mode & 0o777).toBe(0o600);
    for (const name of readdirSync(privateDirectory)) {
      const file = join(privateDirectory, name);
      if (statSync(file).isFile()) expect(statSync(file).mode & 0o777).toBe(0o644);
    }
  });
});
