import { readFile } from "node:fs/promises";
import type { TenantStorageSecretReader } from "../storage/tenant-resolver.js";
import { hasControlCharacter } from "../util/strings.js";

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
  readonly timeoutMs?: number | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
}

export function createVaultTenantSecretReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VaultTenantSecretReader | undefined {
  const address = firstNonEmpty(env.HELIX_VAULT_ADDR, env.VAULT_ADDR);
  const token = firstNonEmpty(env.HELIX_VAULT_TOKEN, env.VAULT_TOKEN);
  const authPath = firstNonEmpty(env.HELIX_VAULT_AUTH_PATH, env.VAULT_AUTH_PATH);
  const role = firstNonEmpty(env.HELIX_VAULT_ROLE, env.VAULT_ROLE);
  if (
    address === undefined ||
    (token === undefined && (authPath === undefined || role === undefined))
  ) {
    return undefined;
  }
  return new VaultTenantSecretReader({
    address,
    token,
    namespace: firstNonEmpty(env.HELIX_VAULT_NAMESPACE, env.VAULT_NAMESPACE),
    mount: firstNonEmpty(env.HELIX_BYO_STORAGE_VAULT_MOUNT) ?? "secret",
    kvVersion: env.HELIX_BYO_STORAGE_VAULT_KV_VERSION === "1" ? 1 : 2,
    authPath,
    role,
    serviceAccountJwtPath: firstNonEmpty(env.HELIX_VAULT_KUBERNETES_JWT_PATH),
    allowInsecureHttp:
      env.NODE_ENV !== "production" && env.HELIX_VAULT_ALLOW_INSECURE_HTTP === "true",
  });
}

interface LeasedToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly renewAt: number;
  readonly renewable: boolean;
}

export class VaultTenantSecretReader implements TenantStorageSecretReader {
  private readonly address: string;
  private readonly mount: string;
  private readonly kvVersion: 1 | 2;
  private readonly namespace: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly readFileText: (path: string) => Promise<string>;
  private readonly timeoutMs: number;
  private readonly staticToken: string | undefined;
  private leasedToken: LeasedToken | undefined;
  private tokenRefresh: Promise<string> | undefined;

  constructor(private readonly options: VaultSecretReaderOptions) {
    this.address = normalizeVaultAddress(options.address, options.allowInsecureHttp === true);
    this.mount = normalizeVaultPathSegment(options.mount ?? "secret");
    this.kvVersion = options.kvVersion ?? 2;
    this.namespace = firstNonEmpty(options.namespace);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readFileText = options.readFileText ?? ((path) => readFile(path, "utf8"));
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error("Vault timeout must be between 1 and 60000 milliseconds.");
    }
    this.staticToken = firstNonEmpty(options.token);
  }

  async read(input: {
    readonly orgId: string;
    readonly scope: "byo-storage" | "idp" | "byo-identity" | "mail-provider";
    readonly handle: string;
  }): Promise<Record<string, string> | undefined> {
    const path = tenantSecretPath(input);
    let response = await this.request(path);
    if (response.status === 403 && this.staticToken === undefined) {
      this.leasedToken = undefined;
      response = await this.request(path);
    }
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Vault secret read failed with status ${String(response.status)}.`);
    }
    return stringRecordFromVaultResponse(await response.json(), this.kvVersion);
  }

  async deleteTenantSecrets(input: { readonly orgId: string }): Promise<number> {
    return this.deleteSecretTree(
      `tenants/${canonicalSecretSegment(input.orgId, "organization id", 200)}`,
    );
  }

  private async deleteSecretTree(path: string): Promise<number> {
    const response = await this.request(path, "LIST", this.kvVersion === 2 ? "metadata" : "data");
    if (response.status === 404) return 0;
    if (!response.ok) {
      throw new Error(`Vault secret listing failed with status ${String(response.status)}.`);
    }
    const keys = readStringArray(readRecord(readRecord(await response.json())?.data)?.keys);
    let deleted = 0;
    for (const key of keys) {
      const childPath = `${path}/${key.replace(/\/$/u, "")}`;
      if (key.endsWith("/")) {
        deleted += await this.deleteSecretTree(childPath);
        continue;
      }
      const removal = await this.request(
        childPath,
        "DELETE",
        this.kvVersion === 2 ? "metadata" : "data",
      );
      if (!removal.ok && removal.status !== 404) {
        throw new Error(`Vault secret deletion failed with status ${String(removal.status)}.`);
      }
      deleted += removal.status === 404 ? 0 : 1;
    }
    return deleted;
  }

  private async request(
    path: string,
    method: "GET" | "LIST" | "DELETE" = "GET",
    endpoint: "data" | "metadata" = "data",
  ): Promise<Response> {
    return this.fetchImpl(this.urlFor(path, endpoint), {
      method,
      headers: await this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      "X-Vault-Token": await this.resolveToken(),
      accept: "application/json",
      ...(this.namespace === undefined ? {} : { "X-Vault-Namespace": this.namespace }),
    };
  }

  private async resolveToken(): Promise<string> {
    if (this.staticToken !== undefined) {
      return this.staticToken;
    }
    this.tokenRefresh ??= this.refreshToken().finally(() => {
      this.tokenRefresh = undefined;
    });
    return this.tokenRefresh;
  }

  private async refreshToken(): Promise<string> {
    const token = this.leasedToken;
    const now = Date.now();
    if (token !== undefined && now < token.renewAt) return token.value;
    if (token !== undefined && token.renewable && now < token.expiresAt) {
      const renewed = await this.renewToken(token.value);
      if (renewed !== undefined) return renewed;
    }
    return this.login();
  }

  private async login(): Promise<string> {
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
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`Vault Kubernetes login failed with status ${String(response.status)}.`);
    }
    return this.rememberLeasedToken(await response.json());
  }

  private async renewToken(token: string): Promise<string | undefined> {
    const response = await this.fetchImpl(`${this.address}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: {
        "X-Vault-Token": token,
        accept: "application/json",
        ...(this.namespace === undefined ? {} : { "X-Vault-Namespace": this.namespace }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return response.ok ? this.rememberLeasedToken(await response.json(), token) : undefined;
  }

  private rememberLeasedToken(payload: unknown, fallback?: string): string {
    const auth = readRecord(readRecord(payload)?.auth);
    const value = readString(auth?.client_token) ?? fallback;
    if (value === undefined) {
      throw new Error("Vault authentication response did not include a client token.");
    }
    const leaseSeconds = readPositiveNumber(auth?.lease_duration) ?? 60;
    const issuedAt = Date.now();
    this.leasedToken = {
      value,
      expiresAt: issuedAt + leaseSeconds * 1_000,
      renewAt: issuedAt + Math.max(1_000, leaseSeconds * 500),
      renewable: auth?.renewable === true,
    };
    return value;
  }

  private urlFor(path: string, endpoint: "data" | "metadata" = "data"): string {
    const normalizedPath = normalizeVaultSecretPath(path);
    const kvPath = this.kvVersion === 2 ? `${endpoint}/${normalizedPath}` : normalizedPath;
    return `${this.address}/v1/${this.mount}/${kvPath}`;
  }
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function tenantSecretPath(input: {
  readonly orgId: string;
  readonly scope: "byo-storage" | "idp" | "byo-identity" | "mail-provider";
  readonly handle: string;
}): string {
  if (!tenantSecretScopes.has(input.scope)) {
    throw new Error("Tenant secret scope is not allowed.");
  }
  const orgId = canonicalSecretSegment(input.orgId, "organization id", 200);
  const handle = canonicalSecretSegment(input.handle, "secret handle", 100);
  return `tenants/${orgId}/${input.scope}/${handle}`;
}

const tenantSecretScopes = new Set(["byo-storage", "idp", "byo-identity", "mail-provider"]);

function normalizeVaultAddress(address: string, allowInsecureHttp: boolean): string {
  const url = new URL(address);
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Vault address must not contain credentials, query parameters, or a fragment.");
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new Error("Vault address must use HTTPS.");
  }
  return url.toString().replace(/\/+$/u, "");
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

function canonicalSecretSegment(value: string, name: string, maxLength: number): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    normalized.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(normalized)
  ) {
    throw new Error(`Tenant ${name} must be a canonical path-safe identifier.`);
  }
  return normalized;
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

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
