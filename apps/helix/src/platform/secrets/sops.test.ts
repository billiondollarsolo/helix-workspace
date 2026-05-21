import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SopsFileSecretsAdapter } from "./sops.js";

describe("SopsFileSecretsAdapter", () => {
  it("loads and validates decrypted JSON secret files", async () => {
    const filePath = await tempSecretFile(
      "secrets.json",
      JSON.stringify({
        DATABASE_URL: "postgres://helix:test@db/helix",
        WEBHOOK_SECRET: "whsec_test",
      }),
    );
    const adapter = new SopsFileSecretsAdapter({
      filePath,
      requiredKeys: ["DATABASE_URL", "WEBHOOK_SECRET"],
    });

    await expect(adapter.require("DATABASE_URL")).resolves.toBe("postgres://helix:test@db/helix");
    await expect(adapter.get("missing")).resolves.toBeUndefined();
    const snapshot = await adapter.load();
    expect(snapshot.version).toMatch(/^sops-file:[a-f0-9]{64}$/);
  });

  it("decrypts SOPS-marked files through the configured decryptor before validation", async () => {
    const filePath = await tempSecretFile(
      "secrets.enc.yaml",
      ["API_TOKEN: ENC[AES256_GCM,data:abc]", "sops:", "  mac: ENC[AES256_GCM,data:def]"].join("\n"),
    );
    const decryptedPaths: string[] = [];
    const adapter = new SopsFileSecretsAdapter({
      filePath,
      decrypt: async (path) => {
        decryptedPaths.push(path);
        return ["API_TOKEN: token-123", "sops:", "  mac: ignored-after-decrypt"].join("\n");
      },
      requiredKeys: ["API_TOKEN"],
    });

    await expect(adapter.require("API_TOKEN")).resolves.toBe("token-123");
    expect(decryptedPaths).toEqual([filePath]);
  });

  it("supports nested secrets only when explicitly enabled", async () => {
    const filePath = await tempSecretFile("secrets.yaml", ["database:", "  password: p@ss"].join("\n"));

    await expect(new SopsFileSecretsAdapter({ filePath }).load()).rejects.toThrow("Secret database");
    await expect(new SopsFileSecretsAdapter({ filePath, allowNested: true }).require("database.password")).resolves.toBe(
      "p@ss",
    );
  });

  it("rejects missing required keys and still-encrypted plaintext", async () => {
    const filePath = await tempSecretFile("secrets.json", JSON.stringify({ API_TOKEN: "ENC[AES256_GCM,data:abc]" }));
    const adapter = new SopsFileSecretsAdapter({
      filePath,
      decrypt: async () => JSON.stringify({ API_TOKEN: "ENC[AES256_GCM,data:abc]" }),
      requiredKeys: ["DATABASE_URL"],
    });

    await expect(adapter.load()).rejects.toThrow("Secret API_TOKEN");
  });
});

async function tempSecretFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "helix-secrets-"));
  const filePath = join(dir, name);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}
