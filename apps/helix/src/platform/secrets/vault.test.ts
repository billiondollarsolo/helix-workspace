import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  VaultTenantSecretReader,
  createVaultTenantSecretReaderFromEnv,
  tenantSecretPath,
} from "./vault.js";

const storageSecret = (orgId = "acme", handle = "s3") => ({
  orgId,
  scope: "byo-storage" as const,
  handle,
});

describe("VaultTenantSecretReader", () => {
  it("reads S3 credentials from Vault KV v2 using the tenant-scoped path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          data: {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
            ignored: 123,
          },
        },
      }),
    );
    const reader = new VaultTenantSecretReader({
      address: "https://vault.internal/",
      token: "vault-token",
      mount: "kv",
      fetchImpl,
    });

    await expect(reader.read(storageSecret())).resolves.toEqual({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://vault.internal/v1/kv/data/tenants/acme/byo-storage/s3",
      {
        method: "GET",
        headers: {
          "X-Vault-Token": "vault-token",
          accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("sends Vault namespace and supports KV v1 response shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          AWS_ACCESS_KEY_ID: "access-key",
          AWS_SECRET_ACCESS_KEY: "secret-key",
        },
      }),
    );
    const reader = new VaultTenantSecretReader({
      address: "https://vault.internal",
      token: "vault-token",
      namespace: "admin/helix",
      mount: "secret",
      kvVersion: 1,
      fetchImpl,
    });

    await expect(reader.read(storageSecret("acme", "aws"))).resolves.toEqual({
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://vault.internal/v1/secret/tenants/acme/byo-storage/aws",
    );
    expect(headerValue(fetchImpl.mock.calls[0]?.[1], "X-Vault-Namespace")).toBe("admin/helix");
  });

  it("logs in with Kubernetes auth and reuses the client token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ auth: { client_token: "vault-client-token" } }))
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({
            data: {
              data: {
                accessKeyId: "access-key",
                secretAccessKey: "secret-key",
              },
            },
          }),
        ),
      );
    const readFileText = vi.fn().mockResolvedValue("service-account-jwt\n");
    const reader = new VaultTenantSecretReader({
      address: "https://vault.internal",
      namespace: "admin/helix",
      authPath: "kubernetes",
      role: "helix",
      serviceAccountJwtPath: "/var/run/token",
      fetchImpl,
      readFileText,
    });

    await reader.read(storageSecret());
    await reader.read(storageSecret("acme", "r2"));

    expect(readFileText).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([
      "https://vault.internal/v1/auth/kubernetes/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-Vault-Namespace": "admin/helix",
        },
        body: JSON.stringify({ role: "helix", jwt: "service-account-jwt" }),
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(headerValue(fetchImpl.mock.calls[1]?.[1], "X-Vault-Token")).toBe("vault-client-token");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns undefined for missing secrets and fails closed on Vault errors or unsafe paths", async () => {
    const missingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ errors: ["not found"] }, { status: 404 }));
    const deniedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ errors: ["denied"] }, { status: 403 }));

    await expect(
      new VaultTenantSecretReader({
        address: "https://vault.internal",
        token: "vault-token",
        fetchImpl: missingFetch,
      }).read(storageSecret("acme", "r2")),
    ).resolves.toBeUndefined();
    await expect(
      new VaultTenantSecretReader({
        address: "https://vault.internal",
        token: "vault-token",
        fetchImpl: deniedFetch,
      }).read(storageSecret()),
    ).rejects.toThrow("Vault secret read failed with status 403.");
    await expect(
      new VaultTenantSecretReader({
        address: "https://vault.internal",
        token: "vault-token",
      }).read(storageSecret("tenant-a/../../tenant-b", "s3")),
    ).rejects.toThrow("canonical path-safe identifier");
  });

  it("builds a reader from token or Kubernetes Vault environment configuration", () => {
    expect(createVaultTenantSecretReaderFromEnv({ VAULT_ADDR: "https://vault" })).toBeUndefined();
    expect(
      createVaultTenantSecretReaderFromEnv({
        HELIX_VAULT_ADDR: "https://vault",
        HELIX_VAULT_TOKEN: "token",
      }),
    ).toBeInstanceOf(VaultTenantSecretReader);
    expect(
      createVaultTenantSecretReaderFromEnv({
        VAULT_ADDR: "https://vault",
        HELIX_VAULT_AUTH_PATH: "kubernetes",
        HELIX_VAULT_ROLE: "helix",
      }),
    ).toBeInstanceOf(VaultTenantSecretReader);
  });

  it("requires TLS unless an explicit non-production opt-in is provided", () => {
    expect(
      () =>
        new VaultTenantSecretReader({
          address: "http://vault.internal",
          token: "vault-token",
        }),
    ).toThrow("must use HTTPS");
    expect(
      new VaultTenantSecretReader({
        address: "http://127.0.0.1:8200",
        token: "vault-token",
        allowInsecureHttp: true,
      }),
    ).toBeInstanceOf(VaultTenantSecretReader);
  });

  it("re-authenticates once after a leased token receives 403", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ auth: { client_token: "expired" } }))
      .mockResolvedValueOnce(Response.json({}, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ auth: { client_token: "replacement" } }))
      .mockResolvedValueOnce(Response.json({ data: { data: { secret: "value" } } }));
    const reader = new VaultTenantSecretReader({
      address: "https://vault.internal",
      authPath: "kubernetes",
      role: "helix",
      fetchImpl,
      readFileText: async () => "jwt",
    });

    await expect(reader.read(storageSecret())).resolves.toEqual({ secret: "value" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(headerValue(fetchImpl.mock.calls[3]?.[1], "X-Vault-Token")).toBe("replacement");
  });

  it("bounds an unavailable Vault request with an abort signal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("Vault request aborted"));
          },
          { once: true },
        );
      });
    });
    const reader = new VaultTenantSecretReader({
      address: "https://vault.internal",
      token: "vault-token",
      timeoutMs: 1,
      fetchImpl,
    });

    await expect(reader.read(storageSecret())).rejects.toThrow();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("renews renewable Kubernetes tokens before lease expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            auth: { client_token: "leased", lease_duration: 10, renewable: true },
          }),
        )
        .mockResolvedValueOnce(Response.json({ data: { data: { secret: "first" } } }))
        .mockResolvedValueOnce(
          Response.json({
            auth: { client_token: "renewed", lease_duration: 10, renewable: true },
          }),
        )
        .mockResolvedValueOnce(Response.json({ data: { data: { secret: "second" } } }));
      const reader = new VaultTenantSecretReader({
        address: "https://vault.internal",
        authPath: "kubernetes",
        role: "helix",
        fetchImpl,
        readFileText: async () => "jwt",
      });

      await reader.read(storageSecret());
      vi.advanceTimersByTime(6_000);
      await reader.read(storageSecret());

      expect(fetchImpl.mock.calls[2]?.[0]).toBe("https://vault.internal/v1/auth/token/renew-self");
      expect(headerValue(fetchImpl.mock.calls[3]?.[1], "X-Vault-Token")).toBe("renewed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives tenant paths only from canonical server-owned segments", () => {
    expect(tenantSecretPath(storageSecret("tenant-a", "primary"))).toBe(
      "tenants/tenant-a/byo-storage/primary",
    );
    expect(() => tenantSecretPath(storageSecret("tenant-a", "../tenant-b"))).toThrow(
      "canonical path-safe identifier",
    );
    expect(() =>
      tenantSecretPath({ ...storageSecret(), scope: "../../platform" as "byo-storage" }),
    ).toThrow("scope is not allowed");
  });

  it("ships a read-only Vault policy limited to server-owned tenant scopes", async () => {
    const policy = await readFile(
      new URL("../../../../../infra/vault/helix-tenant-secrets.hcl", import.meta.url),
      "utf8",
    );
    for (const scope of ["byo-storage", "idp", "byo-identity"]) {
      expect(policy).toContain(`path "secret/data/tenants/+/${scope}/+"`);
    }
    expect(policy).toContain('capabilities = ["read"]');
    expect(policy).not.toMatch(
      /capabilities\s*=\s*\[[^\]]*"(?:create|delete|list|patch|sudo|update)"/u,
    );
  });
});

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  return typeof headers === "object" && !Array.isArray(headers)
    ? (headers as Record<string, string>)[name]
    : undefined;
}
