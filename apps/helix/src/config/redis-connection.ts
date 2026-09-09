import { readFileSync } from "node:fs";
import type { RedisOptions } from "ioredis";
import { readTlsPem, tlsPathValue, type TlsFileReader } from "./tls-files.js";

const TLS_SUBJECT = "Redis";

export interface RedisConnectionEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly REDIS_URL?: string | undefined;
  readonly REDIS_TLS_CA_FILE?: string | undefined;
  readonly REDIS_TLS_CERT_FILE?: string | undefined;
  readonly REDIS_TLS_KEY_FILE?: string | undefined;
}

export function resolveRedisConnection(
  environment: RedisConnectionEnvironment,
  readFile: TlsFileReader = (path) => readFileSync(path),
): { readonly url: string; readonly options: RedisOptions } | undefined {
  const rawUrl = environment.REDIS_URL?.trim();
  if (rawUrl === undefined || rawUrl.length === 0) return undefined;
  const url = new URL(rawUrl);
  const production = environment.NODE_ENV === "production";
  if (production && url.protocol !== "rediss:") {
    throw new Error("Production Redis requires a rediss: URL.");
  }

  const caFile = tlsPathValue(environment.REDIS_TLS_CA_FILE, TLS_SUBJECT);
  const certFile = tlsPathValue(environment.REDIS_TLS_CERT_FILE, TLS_SUBJECT);
  const keyFile = tlsPathValue(environment.REDIS_TLS_KEY_FILE, TLS_SUBJECT);
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error("Redis TLS client certificate and key files must be configured together.");
  }
  if (production && caFile === undefined) {
    throw new Error("Production Redis requires a pinned TLS CA file.");
  }

  if (url.protocol !== "rediss:") return { url: rawUrl, options: {} };
  return {
    url: rawUrl,
    options: {
      tls: {
        rejectUnauthorized: true,
        servername: url.hostname,
        ...(caFile === undefined ? {} : { ca: readTlsPem(caFile, readFile, TLS_SUBJECT) }),
        ...(certFile === undefined ? {} : { cert: readTlsPem(certFile, readFile, TLS_SUBJECT) }),
        ...(keyFile === undefined ? {} : { key: readTlsPem(keyFile, readFile, TLS_SUBJECT) }),
      },
    },
  };
}
