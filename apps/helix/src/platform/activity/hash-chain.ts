/* The tamper-evident hash chain over the `activity` table.
 *
 * Each row commits to its predecessor, so removing or editing a row in the
 * middle is detectable: recomputing the chain from any earlier row no longer
 * reproduces the stored digests.
 *
 * Sheets, Slides, Docs and Calendar each built this link by CONCATENATING the
 * previous value:
 *
 *     const thisHash = `${prevHash ?? "root"}:${verb}:${id}:${Date.now()}`;
 *
 * which is not a hash. Every row was strictly longer than the one before it —
 * `root:sheets.sheet.created:<uuid>:<ts>:slides.deck.created:<uuid>:<ts>:…` —
 * so the column grew without bound. `activity_hash_idx` is a unique btree on
 * it, and once a value passed ~2704 bytes Postgres rejected the insert:
 *
 *     index row size 2712 exceeds btree version 4 maximum 2704
 *
 * At that point every activity write in the organization failed, and with it
 * every operation that records one — creating a sheet, deck, document or
 * event. A workspace disabled its own editors purely by being used.
 *
 * Hashing fixes both problems at once: the link becomes 64 characters
 * regardless of history depth, and it becomes a commitment rather than a
 * transcript. No backfill is needed — the first hashed row is bounded even
 * when its predecessor is one of the oversized strings.
 */

import { createHash } from "node:crypto";

/** The first link, for an organization with no activity yet. */
export const ACTIVITY_CHAIN_ROOT = "root";

export interface ActivityChainLink {
  /** Digest of the preceding row, or `ACTIVITY_CHAIN_ROOT` for the first. */
  readonly prevHash: string | null;
  readonly verb: string;
  /** Id of the object the entry is about. */
  readonly objectId: string;
  /** Milliseconds since the epoch; supplied so callers stay testable. */
  readonly timestamp: number;
}

/**
 * Digest committing to the previous link and this entry's identity.
 *
 * Fields are joined with a separator that cannot occur in a hex digest or a
 * UUID, so two different entries cannot produce the same input string by
 * shifting a delimiter across a field boundary.
 */
export function activityChainHash(link: ActivityChainLink): string {
  const previous = link.prevHash ?? ACTIVITY_CHAIN_ROOT;
  return createHash("sha256")
    .update(`${previous}\n${link.verb}\n${link.objectId}\n${String(link.timestamp)}`, "utf8")
    .digest("hex");
}
