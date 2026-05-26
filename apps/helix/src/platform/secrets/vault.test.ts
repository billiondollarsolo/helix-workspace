import { describe, expect, it, vi } from "vitest";
import {
  VaultTenantStorageSecretReader,
  createVaultTenantStorageSecretReaderFromEnv,
} from "./vault.js";

describe("VaultTenantStorageSecretReader", () => {
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
    const reader = new VaultTenantStorageSecretReader({
      address: "https://vault.internal/",
      token: "vault-token",
      mount: "kv",
      fetchImpl,
    });

    await expect(reader.read("tenants/acme/byo-storage/s3")).resolves.toEqual({
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
    const reader = new VaultTenantStorageSecretReader({
      address: "https://vault.internal",
      token: "vault-token",
      namespace: "admin/helix",
      mount: "secret",
      kvVersion: 1,
      fetchImpl,
    });

    await expect(reader.read("tenants/acme/byo-storage/aws")).resolves.toEqual({
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
    const reader = new VaultTenantStorageSecretReader({
      address: "https://vault.internal",
      namespace: "admin/helix",
      authPath: "kubernetes",
      role: "helix",
      serviceAccountJwtPath: "/var/run/token",
      fetchImpl,
      readFileText,
    });

    await reader.read("tenants/acme/byo-storage/s3");
    await reader.read("tenants/acme/byo-storage/r2");

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
      },
    ]);
    expect(headerValue(fetchImpl.mock.calls[1]?.[1], "X-Vault-Token")).toBe("vault-client-token");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns undefined for missing secrets and fails closed on Vault errors or unsafe paths", async () => {
    const missingFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ errors: ["not found"] }, { status: 404 }),
    );
    const deniedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ errors: ["denied"] }, { status: 403 }),
    );

    await expect(
      new VaultTenantStorageSecretReader({
        address: "https://vault.internal",
        token: "vault-token",
        fetchImpl: missingFetch,
      }).read("tenants/acme/byo-storage/r2"),
    ).resolves.toBeUndefined();
    await expect(
      new VaultTenantStorageSecretReader({
        address: "https://vault.internal",
        token: "vault-token",
        fetchImpl: deniedFetch,
      }).read("tenants/acme/byo-storage/s3"),
    ).rejects.toThrow("Vault secret read failed with status 403.");
    await expect(
      new VaultTenantStorageSecretReader({
        address: "https://vault.internal",
        token: "vault-token",
      }).read("tenants/acme/../s3"),
    ).rejects.toThrow("unsafe path");
  });

  it("builds a reader from token or Kubernetes Vault environment configuration", () => {
    expect(createVaultTenantStorageSecretReaderFromEnv({ VAULT_ADDR: "https://vault" })).toBeUndefined();
    expect(
      createVaultTenantStorageSecretReaderFromEnv({
        HELIX_VAULT_ADDR: "https://vault",
        HELIX_VAULT_TOKEN: "token",
      }),
    ).toBeInstanceOf(VaultTenantStorageSecretReader);
    expect(
      createVaultTenantStorageSecretReaderFromEnv({
        VAULT_ADDR: "https://vault",
        HELIX_VAULT_AUTH_PATH: "kubernetes",
        HELIX_VAULT_ROLE: "helix",
      }),
    ).toBeInstanceOf(VaultTenantStorageSecretReader);
  });
});

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  return typeof headers === "object" && !Array.isArray(headers)
    ? (headers as Record<string, string>)[name]
    : undefined;
}
