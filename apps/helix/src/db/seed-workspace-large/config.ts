/**
 * Shared constants and deterministic helpers for the large workspace seed.
 *
 * All IDs live in the `b000`–`ffff` group ranges, well above those used by the
 * light workspace seed (`0900`–`2400`), so the two seeds never collide.
 */

import { createHash } from "node:crypto";
import type postgres from "postgres";

export const WORKSPACE_SEED_LARGE_SOURCE = "workspace-seed-large";

/** Re-export well-known login actor IDs (same as light seed). */
export const ADMIN_ACTOR = "00000000-0000-4000-8000-000000000110";
export const USER_ACTOR = "00000000-0000-4000-8000-000000000111";

/** Org used by all large-seed rows — same org as the light seed. */
export { DEFAULT_LOCAL_OAUTH_ORG_ID as LARGE_SEED_ORG_ID } from "../seed-local-oauth.js";

export type SeedSql = postgres.Sql | postgres.TransactionSql;

// ---------------------------------------------------------------------------
// ID generation — deterministic, non-colliding with the light seed.
// ---------------------------------------------------------------------------

/**
 * Deterministic UUID for the large seed.
 * group: 4-char hex prefix (e.g. "b000"), index: 0..99_999_999
 */
export function uid(group: string, index: number): string {
  return `00000000-0000-4000-8000-${group}${index.toString().padStart(8, "0")}`;
}

/** SHA-256 hex of a string (used for dedup and fake content hashes). */
export function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Wrap a JS value as a postgres.Parameter JSON binding. */
export function json(sql: SeedSql, value: postgres.JSONValue): postgres.Parameter {
  return sql.json(value);
}

// ---------------------------------------------------------------------------
// Temporal anchor — "now" relative to seed execution.
// ---------------------------------------------------------------------------

export const NOW = new Date("2026-05-21T16:00:00.000Z");

export function daysFromNow(days: number, hour = 9, minute = 0): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// 23 teammate actors (b001..b023).
// ---------------------------------------------------------------------------

export const LARGE_TEAM = [
  { idx: 1,  email: "alex.torres@helix.local",    displayName: "Alex Torres",    title: "Staff Engineer" },
  { idx: 2,  email: "ben.hayes@helix.local",       displayName: "Ben Hayes",      title: "Backend Engineer" },
  { idx: 3,  email: "celia.wright@helix.local",    displayName: "Celia Wright",   title: "Frontend Engineer" },
  { idx: 4,  email: "diana.singh@helix.local",     displayName: "Diana Singh",    title: "Product Manager" },
  { idx: 5,  email: "evan.brooks@helix.local",     displayName: "Evan Brooks",    title: "Data Engineer" },
  { idx: 6,  email: "fiona.marsh@helix.local",     displayName: "Fiona Marsh",    title: "UX Researcher" },
  { idx: 7,  email: "gabriel.luna@helix.local",    displayName: "Gabriel Luna",   title: "Security Engineer" },
  { idx: 8,  email: "hannah.price@helix.local",    displayName: "Hannah Price",   title: "Engineering Manager" },
  { idx: 9,  email: "ivan.petrov@helix.local",     displayName: "Ivan Petrov",    title: "SRE" },
  { idx: 10, email: "jade.osei@helix.local",       displayName: "Jade Osei",      title: "Content Designer" },
  { idx: 11, email: "kai.nakamura@helix.local",    displayName: "Kai Nakamura",   title: "Mobile Engineer" },
  { idx: 12, email: "lena.fischer@helix.local",    displayName: "Lena Fischer",   title: "Legal Counsel" },
  { idx: 13, email: "marco.vitale@helix.local",    displayName: "Marco Vitale",   title: "Solutions Engineer" },
  { idx: 14, email: "nina.patel@helix.local",      displayName: "Nina Patel",     title: "Customer Success" },
  { idx: 15, email: "omar.hassan@helix.local",     displayName: "Omar Hassan",    title: "Infrastructure Engineer" },
  { idx: 16, email: "petra.novak@helix.local",     displayName: "Petra Novak",    title: "QA Lead" },
  { idx: 17, email: "quinn.reed@helix.local",      displayName: "Quinn Reed",     title: "Technical Writer" },
  { idx: 18, email: "rosa.kim@helix.local",        displayName: "Rosa Kim",       title: "Analytics Engineer" },
  { idx: 19, email: "sam.walker@helix.local",      displayName: "Sam Walker",     title: "Product Designer" },
  { idx: 20, email: "tara.chan@helix.local",        displayName: "Tara Chan",      title: "Business Development" },
  { idx: 21, email: "ulrich.weber@helix.local",    displayName: "Ulrich Weber",   title: "Principal Engineer" },
  { idx: 22, email: "vera.stone@helix.local",      displayName: "Vera Stone",     title: "Recruiting Lead" },
  { idx: 23, email: "will.cross@helix.local",      displayName: "Will Cross",     title: "DevOps Engineer" },
] as const;

export type LargeTeamMember = (typeof LARGE_TEAM)[number];

/** Get actor ID for a LARGE_TEAM member by its idx. */
export function teamId(idx: number): string {
  return uid("b000", idx);
}

// ---------------------------------------------------------------------------
// Folder IDs used across surfaces (b100..b1xx).
// ---------------------------------------------------------------------------
export const FOLDER = {
  root:           uid("b100", 1),
  engineering:    uid("b100", 2),
  backend:        uid("b100", 3),
  frontend:       uid("b100", 4),
  infra:          uid("b100", 5),
  product:        uid("b100", 6),
  roadmap:        uid("b100", 7),
  research:       uid("b100", 8),
  design:         uid("b100", 9),
  ux:             uid("b100", 10),
  brand:          uid("b100", 11),
  finance:        uid("b100", 12),
  payroll:        uid("b100", 13),
  contracts:      uid("b100", 14),
  marketing:      uid("b100", 15),
  campaigns:      uid("b100", 16),
  content:        uid("b100", 17),
  people:         uid("b100", 18),
  hiring:         uid("b100", 19),
  onboarding:     uid("b100", 20),
  legal:          uid("b100", 21),
  security:       uid("b100", 22),
  data:           uid("b100", 23),
} as const;

/** Grant a resource to BOTH login actors so either account sees it. */
export async function grantBoth(
  sql: SeedSql,
  orgId: string,
  resourceType: string,
  resourceId: string,
  role: string,
): Promise<void> {
  for (const actorId of [ADMIN_ACTOR, USER_ACTOR]) {
    await sql`
      insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${ADMIN_ACTOR})
      on conflict do nothing
    `;
  }
}
