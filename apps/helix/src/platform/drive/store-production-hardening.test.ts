import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const storeUrl = new URL("./store.ts", import.meta.url);

describe("Drive production store invariants", () => {
  it("scopes recipients to the organization and never queries a raw share token", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toMatch(
      /from actors[\s\S]+id = \$\{targetActorId\}[\s\S]+org_id = \$\{input\.orgId\}/u,
    );
    expect(source).toContain("token_hash = decode(${hashDriveShareToken(input.token)}, 'hex')");
    expect(source).not.toContain("where token = ${");
  });

  it("atomically enforces link expiry, download count, rate, and revocation", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain("download_count = download_count + 1");
    expect(source).toContain("download_count < max_downloads");
    expect(source).toContain("rate_window_count < rate_limit_per_hour");
    expect(source).toContain("revoked_at is null");
  });

  it("blocks hard delete for holds, shares, jobs, and retention", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain("driveHardDeleteBlockers");
    expect(source).toContain("from drive_scan_jobs");
    expect(source).toContain("from drive_share_links");
    expect(source).toContain("trashExpiresAt");
  });

  it("claims bounded orphan batches with skip-locked semantics", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain("for update skip locked");
    expect(source).toContain("abortMultipartUpload");
    expect(source).toContain("refcount <= 0");
    expect(source).toContain("input.dryRun");
  });
});
