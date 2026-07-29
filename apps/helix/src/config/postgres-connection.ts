import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";

const MAX_TLS_FILE_BYTES = 1024 * 1024;

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
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): PostgresSslOptions | false {
  const caFile = pathValue(environment.POSTGRES_TLS_CA_FILE);
  const certFile = pathValue(environment.POSTGRES_TLS_CERT_FILE);
  const keyFile = pathValue(environment.POSTGRES_TLS_KEY_FILE);

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
    ...(caFile === undefined ? {} : { ca: readPem(caFile, readFile) }),
    ...(certFile === undefined ? {} : { cert: readPem(certFile, readFile) }),
    ...(keyFile === undefined ? {} : { key: readPem(keyFile, readFile) }),
  };
}

function pathValue(value: string | undefined): string | undefined {
  const path = value?.trim();
  if (path === undefined || path.length === 0) return undefined;
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("PostgreSQL TLS files must use absolute paths.");
  }
  return path;
}

function readPem(path: string, readFile: (path: string) => Buffer): Buffer {
  try {
    const contents = readFile(path);
    if (contents.byteLength === 0 || contents.byteLength > MAX_TLS_FILE_BYTES) {
      throw new Error("invalid TLS file");
    }
    return contents;
  } catch {
    throw new Error("PostgreSQL TLS file is unreadable or invalid.");
  }
}
