import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Short-lived certificates for tests, issued with the openssl CLI: a root, an
 * intermediate it signed, and server certificates signed by the intermediate.
 * Nothing here is written to the repository.
 */

export interface TestServerCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

export interface TestCertificateAuthority {
  readonly rootPem: string;
  readonly intermediatePem: string;
  /** Issues a server certificate for the given DNS names. */
  issue(
    names: readonly string[],
    options?: {
      readonly key?: "rsa:2048" | "rsa:1024" | "ec:prime256v1" | "ed25519";
      readonly days?: number;
      /** Identify the certificate by its alternative names only. */
      readonly emptySubject?: boolean;
    },
  ): TestServerCertificate;
  /** Removes the working directory. */
  dispose(): void;
}

function openssl(args: readonly string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function keyArguments(key: string): readonly string[] {
  if (key.startsWith("rsa:")) return ["-newkey", key];
  if (key.startsWith("ec:"))
    return ["-newkey", "ec", "-pkeyopt", `ec_paramgen_curve:${key.slice(3)}`];
  return ["-newkey", key];
}

export function createTestCertificateAuthority(): TestCertificateAuthority {
  const directory = mkdtempSync(join(tmpdir(), "helix-test-pki-"));
  const path = (name: string) => join(directory, name);
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    path("root.key"),
    "-out",
    path("root.pem"),
    "-subj",
    "/CN=Test Root CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path("intermediate.key"),
    "-out",
    path("intermediate.csr"),
    "-subj",
    "/CN=Test Issuing CA",
  ]);
  writeFileSync(
    path("intermediate.ext"),
    "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  openssl([
    "x509",
    "-req",
    "-in",
    path("intermediate.csr"),
    "-days",
    "2",
    "-CA",
    path("root.pem"),
    "-CAkey",
    path("root.key"),
    "-CAcreateserial",
    "-extfile",
    path("intermediate.ext"),
    "-out",
    path("intermediate.pem"),
  ]);
  let serial = 0;
  return {
    rootPem: readFileSync(path("root.pem"), "utf8"),
    intermediatePem: readFileSync(path("intermediate.pem"), "utf8"),
    issue(names, options = {}) {
      serial += 1;
      const base = `leaf-${String(serial)}`;
      openssl([
        "req",
        ...keyArguments(options.key ?? "rsa:2048"),
        "-nodes",
        "-keyout",
        path(`${base}.key`),
        "-out",
        path(`${base}.csr`),
        "-subj",
        options.emptySubject === true ? "/" : `/CN=${names[0] ?? "unnamed"}`,
      ]);
      writeFileSync(
        path(`${base}.ext`),
        `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${
          options.emptySubject === true ? "critical," : ""
        }${names.map((name) => `DNS:${name}`).join(",")}\n`,
      );
      openssl([
        "x509",
        "-req",
        "-in",
        path(`${base}.csr`),
        "-days",
        String(options.days ?? 2),
        "-CA",
        path("intermediate.pem"),
        "-CAkey",
        path("intermediate.key"),
        "-CAcreateserial",
        "-extfile",
        path(`${base}.ext`),
        "-out",
        path(`${base}.pem`),
      ]);
      return {
        certificatePem: readFileSync(path(`${base}.pem`), "utf8"),
        privateKeyPem: readFileSync(path(`${base}.key`), "utf8"),
      };
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
