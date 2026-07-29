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
    const resolver = source.slice(
      source.indexOf("async resolveShareLink"),
      source.indexOf("async readFileByShareToken"),
    );
    expect(source).toContain("download_count = download_count + 1");
    expect(source).toContain("download_count < max_downloads");
    expect(source).toContain("rate_window_count < rate_limit_per_hour");
    expect(source).toContain("revoked_at is null");
    expect(resolver.indexOf("rate_window_count = case")).toBeLessThan(
      resolver.indexOf("verifyDriveSharePassword"),
    );
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
    expect(source).toContain("then 'single'");
    expect(source).toContain('row.kind === "single"');
    expect(source).toContain("await storage.delete(row.storage_key)");
    expect(source).toContain("refcount <= 0");
    expect(source).toContain("input.dryRun");
  });

  it("reserves pending declared bytes in tenant quota accounting", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain("or obj.upload_state = 'pending_upload'");
  });
});
