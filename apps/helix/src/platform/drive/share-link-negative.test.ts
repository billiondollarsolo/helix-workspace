/**
 * D10 — Expanded sharing negative access matrix.
 *
 * Exercises public share-link enforcement using the real
 * `share-link-security` helpers plus a recording SQL driver for
 * `resolveShareLink` / `readFileByShareToken` gate conditions:
 * password guess, raw-token DB leak, expiry, max downloads, rate limit,
 * revoke-during-download, non-active object content denial.
 */
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  hashDriveSharePassword,
  hashDriveShareToken,
  safeDriveDownloadPolicy,
} from "./share-link-security.js";
import { PostgresDriveStore, type DriveStorageClient } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const linkId = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const rawToken = "public-share-token-value-not-stored-raw";
const now = new Date("2026-08-01T12:00:00.000Z");

interface ShareLinkRowShape {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly role: string;
  readonly password_hash: string | null;
  readonly expires_at: Date | null;
  readonly max_downloads: number | null;
  readonly download_count: number;
  readonly rate_limit_per_hour: number;
  readonly rate_window_started_at: Date;
  readonly rate_window_count: number;
  readonly revoked_at: Date | null;
  readonly created_by_actor_id: string | null;
  readonly token_hash?: Buffer;
}

function baseLink(overrides: Partial<ShareLinkRowShape> = {}): ShareLinkRowShape {
  return {
    id: linkId,
    org_id: orgId,
    object_id: objectId,
    role: "reader",
    password_hash: null,
    expires_at: null,
    max_downloads: null,
    download_count: 0,
    rate_limit_per_hour: 120,
    rate_window_started_at: now,
    rate_window_count: 0,
    revoked_at: null,
    created_by_actor_id: actorId,
    ...overrides,
  };
}

function activeObjectProps() {
  return {
    id: objectId,
    org_id: orgId,
    owner_actor_id: actorId,
    kind: "file",
    storage_key: "drive/shared.bin",
    mime_type: "application/pdf",
    byte_size: 12,
    sha256: "b".repeat(64),
    upload_state: "active",
    metadata: { name: "shared.pdf", status: "ready" },
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

type SqlScenario = {
  readonly candidate?: ShareLinkRowShape | null;
  /** Rows returned by the rate-window UPDATE (admission). Empty = rate/max deny. */
  readonly admitted?: readonly { readonly password_hash: string | null }[];
  /** Rows returned by the download_count UPDATE. Empty = race/max deny. */
  readonly consumed?: readonly {
    readonly org_id: string;
    readonly object_id: string;
    readonly role: string;
    readonly created_by_actor_id: string | null;
  }[];
  readonly object?: Record<string, unknown> | null;
  readonly stillActive?: boolean;
  readonly calls?: string[];
};

function createShareSql(scenario: SqlScenario): postgres.Sql {
  const calls = scenario.calls ?? [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push(text);

    // Mid-download revoke recheck (after bytes are loaded).
    if (
      text.includes("from drive_share_links") &&
      text.includes("token_hash = decode") &&
      text.includes("select 1")
    ) {
      return Promise.resolve(scenario.stillActive === false ? [] : [{ "?column?": 1 }]);
    }

    if (text.includes("from drive_share_links") && text.includes("token_hash = decode")) {
      if (scenario.candidate === null || scenario.candidate === undefined) {
        return Promise.resolve([]);
      }
      // Token lookup uses hash of the presented token — raw token never matches digest.
      const presented = typeof values[0] === "string" ? values[0] : "";
      const expectedHash = hashDriveShareToken(rawToken);
      if (presented !== expectedHash) {
        return Promise.resolve([]);
      }
      return Promise.resolve([scenario.candidate]);
    }

    if (
      text.includes("update drive_share_links") &&
      text.includes("rate_window_count") &&
      text.includes("returning password_hash")
    ) {
      return Promise.resolve(
        scenario.admitted ?? [{ password_hash: scenario.candidate?.password_hash ?? null }],
      );
    }

    if (
      text.includes("update drive_share_links") &&
      text.includes("download_count = download_count + 1")
    ) {
      return Promise.resolve(
        scenario.consumed ??
          (scenario.candidate === null || scenario.candidate === undefined
            ? []
            : [
                {
                  org_id: scenario.candidate.org_id,
                  object_id: scenario.candidate.object_id,
                  role: scenario.candidate.role,
                  created_by_actor_id: scenario.candidate.created_by_actor_id,
                },
              ]),
      );
    }

    if (text.includes("from objects") && text.includes("upload_state = 'active'")) {
      if (scenario.object === null) return Promise.resolve([]);
      return Promise.resolve([scenario.object ?? activeObjectProps()]);
    }

    if (text.includes("from drive_versions") && text.includes("max(version_number)")) {
      return Promise.resolve([{ version_number: 1 }]);
    }

    if (
      text.includes("from drive_share_links") &&
      text.includes("revoked_at is null") &&
      text.includes("select 1")
    ) {
      return Promise.resolve(scenario.stillActive === false ? [] : [{ "?column?": 1 }]);
    }

    if (text.includes("insert into drive_activity") || text.includes("drive_activity")) {
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  };
  const sql = tag as unknown as postgres.Sql;
  Object.assign(sql, {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
    json: (value: unknown) => value,
  });
  return sql;
}

describe("D10 sharing negative access matrix", () => {
  it("never stores or matches a raw token (DB leak simulation)", async () => {
    // Presenting the raw token string as if it were the stored digest must fail.
    expect(hashDriveShareToken(rawToken)).not.toBe(rawToken);
    expect(hashDriveShareToken(rawToken)).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashDriveShareToken(rawToken)).toBe(hashDriveShareToken(rawToken));

    const sql = createShareSql({
      candidate: baseLink(),
    });
    const store = new PostgresDriveStore(sql);
    // Wrong token → no candidate.
    await expect(store.resolveShareLink?.({ token: "guessed-token" })).resolves.toBeNull();
  });

  it("rejects wrong password guesses without revealing the object", async () => {
    const passwordHash = await hashDriveSharePassword("correct horse battery");
    const sql = createShareSql({
      candidate: baseLink({ password_hash: passwordHash }),
      admitted: [{ password_hash: passwordHash }],
    });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.resolveShareLink?.({ token: rawToken, password: "wrong password" }),
    ).resolves.toBeNull();
    await expect(store.resolveShareLink?.({ token: rawToken })).resolves.toBeNull();
  });

  it("accepts the correct password for a protected link", async () => {
    const passwordHash = await hashDriveSharePassword("correct horse battery");
    const sql = createShareSql({
      candidate: baseLink({ password_hash: passwordHash }),
      admitted: [{ password_hash: passwordHash }],
    });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.resolveShareLink?.({ token: rawToken, password: "correct horse battery" }),
    ).resolves.toMatchObject({ orgId, objectId, role: "reader" });
  });

  it("denies when the hourly rate window is exhausted", async () => {
    const sql = createShareSql({
      candidate: baseLink({ rate_limit_per_hour: 1, rate_window_count: 1 }),
      admitted: [], // rate UPDATE matches zero rows
    });
    const store = new PostgresDriveStore(sql);
    await expect(store.resolveShareLink?.({ token: rawToken })).resolves.toBeNull();
  });

  it("denies when max downloads is already consumed", async () => {
    const sql = createShareSql({
      candidate: baseLink({ max_downloads: 1, download_count: 1 }),
      admitted: [],
    });
    const store = new PostgresDriveStore(sql);
    await expect(store.resolveShareLink?.({ token: rawToken })).resolves.toBeNull();
  });

  it("denies expired links at candidate lookup", async () => {
    // Expired candidates are filtered in SQL (expires_at > now()). Emulate empty candidate set.
    const sql = createShareSql({ candidate: null });
    const store = new PostgresDriveStore(sql);
    await expect(store.resolveShareLink?.({ token: rawToken })).resolves.toBeNull();
  });

  it("denies download when the link is revoked mid-flight after content load", async () => {
    const get = vi.fn<DriveStorageClient["get"]>().mockResolvedValue({
      key: "drive/shared.bin",
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    const storage: DriveStorageClient = {
      async put() {},
      get,
      async delete() {},
    };
    const sql = createShareSql({
      candidate: baseLink(),
      object: activeObjectProps(),
      stillActive: false,
    });
    const store = new PostgresDriveStore(sql, storage);
    await expect(store.readFileByShareToken?.({ token: rawToken })).resolves.toBeNull();
    // Bytes may have been fetched, but the gate must still return null (no content leak).
  });

  it("denies share-token content for non-active (quarantined) objects", async () => {
    const get = vi.fn<DriveStorageClient["get"]>();
    const storage: DriveStorageClient = {
      async put() {},
      get,
      async delete() {},
    };
    const sql = createShareSql({
      candidate: baseLink(),
      object: null, // SQL filter upload_state = 'active' returns nothing
    });
    const store = new PostgresDriveStore(sql, storage);
    await expect(store.readFileByShareToken?.({ token: rawToken })).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("forces active MIME types to opaque attachment disposition", () => {
    for (const mimeType of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml"]) {
      expect(safeDriveDownloadPolicy({ mimeType, requestedInline: true })).toEqual({
        mimeType: "application/octet-stream",
        disposition: "attachment",
      });
    }
    expect(safeDriveDownloadPolicy({ mimeType: "application/pdf", requestedInline: true })).toEqual(
      { mimeType: "application/pdf", disposition: "inline" },
    );
  });
});
