import { readFile } from "node:fs/promises";
import type { TenantStorageSecretReader } from "../storage/tenant-resolver.js";

export interface VaultSecretReaderOptions {
  readonly address: string;
  readonly token?: string | undefined;
  readonly namespace?: string | undefined;
  readonly mount?: string | undefined;
  readonly kvVersion?: 1 | 2 | undefined;
  readonly authPath?: string | undefined;
  readonly role?: string | undefined;
  readonly serviceAccountJwtPath?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly readFileText?: ((path: string) => Promise<string>) | undefined;
}

export function createVaultTenantStorageSecretReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TenantStorageSecretReader | undefined {
  const address = firstNonEmpty(env.HELIX_VAULT_ADDR, env.VAULT_ADDR);
  const token = firstNonEmpty(env.HELIX_VAULT_TOKEN, env.VAULT_TOKEN);
  const authPath = firstNonEmpty(env.HELIX_VAULT_AUTH_PATH, env.VAULT_AUTH_PATH);
  const role = firstNonEmpty(env.HELIX_VAULT_ROLE, env.VAULT_ROLE);
  if (address === undefined || (token === undefined && (authPath === undefined || role === undefined))) {
    return undefined;
  }
  return new VaultTenantStorageSecretReader({
    address,
    token,
    namespace: firstNonEmpty(env.HELIX_VAULT_NAMESPACE, env.VAULT_NAMESPACE),
    mount: firstNonEmpty(env.HELIX_BYO_STORAGE_VAULT_MOUNT) ?? "secret",
    kvVersion: env.HELIX_BYO_STORAGE_VAULT_KV_VERSION === "1" ? 1 : 2,
    authPath,
    role,
    serviceAccountJwtPath: firstNonEmpty(env.HELIX_VAULT_KUBERNETES_JWT_PATH),
  });
}

export class VaultTenantStorageSecretReader implements TenantStorageSecretReader {
  private readonly address: string;
  private readonly mount: string;
  private readonly kvVersion: 1 | 2;
  private readonly namespace: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly readFileText: (path: string) => Promise<string>;
  private token: string | undefined;

  constructor(private readonly options: VaultSecretReaderOptions) {
    this.address = options.address.replace(/\/+$/u, "");
    this.mount = normalizeVaultPathSegment(options.mount ?? "secret");
    this.kvVersion = options.kvVersion ?? 2;
    this.namespace = firstNonEmpty(options.namespace);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readFileText = options.readFileText ?? ((path) => readFile(path, "utf8"));
    this.token = firstNonEmpty(options.token);
  }

  async read(path: string): Promise<Record<string, string> | undefined> {
    const response = await this.fetchImpl(this.urlFor(path), {
      method: "GET",
      headers: await this.headers(),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Vault secret read failed with status ${String(response.status)}.`);
    }
    return stringRecordFromVaultResponse(await response.json(), this.kvVersion);
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      "X-Vault-Token": await this.resolveToken(),
      accept: "application/json",
      ...(this.namespace === undefined ? {} : { "X-Vault-Namespace": this.namespace }),
    };
  }

  private async resolveToken(): Promise<string> {
    if (this.token !== undefined) {
      return this.token;
    }
    const authPath = firstNonEmpty(this.options.authPath);
    const role = firstNonEmpty(this.options.role);
    if (authPath === undefined || role === undefined) {
      throw new Error("Vault token or Kubernetes auth configuration is required.");
    }
    const jwtPath =
      firstNonEmpty(this.options.serviceAccountJwtPath) ??
      "/var/run/secrets/kubernetes.io/serviceaccount/token";
    const response = await this.fetchImpl(
      `${this.address}/v1/auth/${normalizeVaultSecretPath(authPath)}/login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.namespace === undefined ? {} : { "X-Vault-Namespace": this.namespace }),
        },
        body: JSON.stringify({
          role,
          jwt: (await this.readFileText(jwtPath)).trim(),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Vault Kubernetes login failed with status ${String(response.status)}.`);
    }
    const clientToken = readString(readRecord(readRecord(await response.json())?.auth)?.client_token);
    if (clientToken === undefined) {
      throw new Error("Vault Kubernetes login response did not include a client token.");
    }
    this.token = clientToken;
    return clientToken;
  }

  private urlFor(path: string): string {
    const normalizedPath = normalizeVaultSecretPath(path);
    const kvPath = this.kvVersion === 2 ? `data/${normalizedPath}` : normalizedPath;
    return `${this.address}/v1/${this.mount}/${kvPath}`;
  }
}

function stringRecordFromVaultResponse(
  payload: unknown,
  kvVersion: 1 | 2,
): Record<string, string> | undefined {
  const root = readRecord(payload);
  const data = readRecord(root?.data);
  const secret = kvVersion === 2 ? readRecord(data?.data) : data;
  if (secret === undefined) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(secret)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

function normalizeVaultSecretPath(path: string): string {
  return path
    .split("/")
    .map((part) => normalizeVaultPathSegment(part))
    .join("/");
}

function normalizeVaultPathSegment(segment: string): string {
  const trimmed = segment.trim().replace(/^\/+|\/+$/gu, "");
  if (
    trimmed.length === 0 ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    hasControlCharacter(trimmed)
  ) {
    throw new Error("Vault secret path must not be empty or contain unsafe path segments.");
  }
  return encodeURIComponent(trimmed);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}
