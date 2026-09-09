import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0089 MFA session assurance", () => {
  it("adds Better Auth TOTP state and complete session-bound assurance", async () => {
    const migration = await readFile(
      new URL("./0089_mfa_session_assurance.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('create table if not exists "twoFactor"');
    expect(migration).toContain('"twoFactorEnabled" boolean not null default false');
    expect(migration).toContain("mfa_verified_at timestamptz");
    expect(migration).toContain("mfa_audience text");
    expect(migration).toContain("better_auth_session_mfa_assurance_complete");
  });
});
