import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0156 passkeys and recovery codes", () => {
  it("binds credentials uniquely with nonnegative counters and stores only recovery digests", async () => {
    const migration = await readFile(
      new URL("./0156_passkeys_and_recovery_codes.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('unique index if not exists better_auth_passkey_credential_idx');
    expect(migration).toContain("better_auth_account_issuer_idx");
    expect(migration).toContain("counter >= 0");
    expect(migration).toContain("new.counter <= old.counter");
    expect(migration).toContain("code_digest ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("consumed_at is null");
    expect(migration).not.toContain("code_plaintext");
  });
});
