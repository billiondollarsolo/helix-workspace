import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { readTlsPem, tlsPathValue, type TlsFileReader } from "./tls-files.js";

const TLS_SUBJECT = "PostgreSQL";

export interface PostgresConnectionEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly POSTGRES_TLS_CA_FILE?: string | undefined;
  readonly POSTGRES_TLS_CERT_FILE?: string | undefined;
  readonly POSTGRES_TLS_KEY_FILE?: string | undefined;
}

export type PostgresSslOptions = ConnectionOptions & {
  readonly rejectUnauthorized: true;
};

/**
 * Build a CA-pinned PostgreSQL TLS policy without placing certificate material
 * in URLs, logs, or environment values. Production requires TLS; optional
 * client mTLS is accepted only as a complete certificate/key pair.
 */
export function resolvePostgresSsl(
  environment: PostgresConnectionEnvironment,
  readFile: TlsFileReader = (path) => readFileSync(path),
): PostgresSslOptions | false {
  const caFile = tlsPathValue(environment.POSTGRES_TLS_CA_FILE, TLS_SUBJECT);
  const certFile = tlsPathValue(environment.POSTGRES_TLS_CERT_FILE, TLS_SUBJECT);
  const keyFile = tlsPathValue(environment.POSTGRES_TLS_KEY_FILE, TLS_SUBJECT);

  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error("PostgreSQL TLS client certificate and key files must be configured together.");
  }
  if (environment.NODE_ENV === "production" && caFile === undefined) {
    throw new Error("Production PostgreSQL requires a pinned TLS CA file.");
  }
  if (caFile === undefined && certFile === undefined) {
    return false;
  }

  return {
    rejectUnauthorized: true,
    ...(caFile === undefined ? {} : { ca: readTlsPem(caFile, readFile, TLS_SUBJECT) }),
    ...(certFile === undefined ? {} : { cert: readTlsPem(certFile, readFile, TLS_SUBJECT) }),
    ...(keyFile === undefined ? {} : { key: readTlsPem(keyFile, readFile, TLS_SUBJECT) }),
  };
}
