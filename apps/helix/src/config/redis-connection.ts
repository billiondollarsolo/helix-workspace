import { readFileSync } from "node:fs";
import type { RedisOptions } from "ioredis";

export interface RedisConnectionEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly REDIS_URL?: string | undefined;
  readonly REDIS_TLS_CA_FILE?: string | undefined;
  readonly REDIS_TLS_CERT_FILE?: string | undefined;
  readonly REDIS_TLS_KEY_FILE?: string | undefined;
}

export function resolveRedisConnection(
  environment: RedisConnectionEnvironment,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): { readonly url: string; readonly options: RedisOptions } | undefined {
  const rawUrl = environment.REDIS_URL?.trim();
  if (rawUrl === undefined || rawUrl.length === 0) return undefined;
  const url = new URL(rawUrl);
  const production = environment.NODE_ENV === "production";
  if (production && url.protocol !== "rediss:") {
    throw new Error("Production Redis requires a rediss: URL.");
  }

  const caFile = pathValue(environment.REDIS_TLS_CA_FILE);
  const certFile = pathValue(environment.REDIS_TLS_CERT_FILE);
  const keyFile = pathValue(environment.REDIS_TLS_KEY_FILE);
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
        ...(caFile === undefined ? {} : { ca: readPem(caFile, readFile) }),
        ...(certFile === undefined ? {} : { cert: readPem(certFile, readFile) }),
        ...(keyFile === undefined ? {} : { key: readPem(keyFile, readFile) }),
      },
    },
  };
}

function pathValue(value: string | undefined): string | undefined {
  const path = value?.trim();
  if (path === undefined || path.length === 0) return undefined;
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("Redis TLS files must use absolute paths.");
  }
  return path;
}

function readPem(path: string, readFile: (path: string) => Buffer): Buffer {
  try {
    const contents = readFile(path);
    if (contents.byteLength === 0 || contents.byteLength > 1024 * 1024) {
      throw new Error("invalid TLS file");
    }
    return contents;
  } catch {
    throw new Error("Redis TLS file is unreadable or invalid.");
  }
}
