/**
 * Seed ~50 activity/notification entries for the large workspace seed.
 * Uses the activity table keyed by (this_hash).
 */

import {
  ADMIN_ACTOR,
  WORKSPACE_SEED_LARGE_SOURCE,
  daysFromNow,
  json,
  sha,
  teamId,
  uid,
  type SeedSql,
} from "./config.js";

interface ActivityEntry {
  readonly actor: string;
  readonly verb: string;
  readonly objectType: string;
  readonly objectIdFn: () => string;
  readonly summary: string;
  readonly daysAgo: number;
}

const ENTRIES: readonly ActivityEntry[] = [
  // Document activity
  { actor: teamId(4),  verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 1),  summary: "Diana Singh commented on \"Engineering Onboarding Guide\".", daysAgo: 0 },
  { actor: teamId(21), verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 2),  summary: "Ulrich Weber commented on \"Architecture Overview — v2\".", daysAgo: 1 },
  { actor: teamId(6),  verb: "docs.document.shared",    objectType: "document", objectIdFn: () => uid("e100", 18), summary: "Fiona Marsh shared \"User Research: Enterprise Pilot Findings\" with you.", daysAgo: 1 },
  { actor: teamId(19), verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 26), summary: "Sam Walker commented on \"Design System v2\".", daysAgo: 2 },
  { actor: teamId(4),  verb: "docs.comment.resolved",   objectType: "document", objectIdFn: () => uid("e100", 19), summary: "Diana Singh resolved a comment on \"Assistant Design Spec\".", daysAgo: 2 },
  { actor: teamId(9),  verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 5),  summary: "Ivan Petrov commented on \"On-call Runbook — v2\".", daysAgo: 3 },
  { actor: teamId(1),  verb: "docs.document.shared",    objectType: "document", objectIdFn: () => uid("e100", 9),  summary: "Alex Torres shared \"Mail Architecture\" with you.", daysAgo: 3 },
  { actor: teamId(6),  verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 30), summary: "Fiona Marsh commented on \"UX Research Plan — Q3 2026\".", daysAgo: 4 },
  { actor: teamId(5),  verb: "docs.document.shared",    objectType: "document", objectIdFn: () => uid("e100", 47), summary: "Evan Brooks shared \"Monthly Product Metrics Report — April 2026\" with you.", daysAgo: 4 },
  { actor: teamId(21), verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 75), summary: "Ulrich Weber commented on \"Assistant Tool Registry Spec\".", daysAgo: 5 },

  // Drive file activity
  { actor: teamId(1),  verb: "drive.file.shared",       objectType: "object",   objectIdFn: () => uid("f000", 3),  summary: "Alex Torres shared \"ERD-v4.png\" with you.", daysAgo: 0 },
  { actor: teamId(19), verb: "drive.file.shared",       objectType: "object",   objectIdFn: () => uid("f000", 68), summary: "Sam Walker shared \"figma-export-drive-browser.zip\" with you.", daysAgo: 1 },
  { actor: teamId(6),  verb: "drive.file.shared",       objectType: "object",   objectIdFn: () => uid("f000", 64), summary: "Fiona Marsh shared \"session-recording-export.zip\" with you.", daysAgo: 2 },
  { actor: teamId(7),  verb: "drive.file.shared",       objectType: "object",   objectIdFn: () => uid("f000", 49), summary: "Gabriel Luna shared \"pentest-report-may.pdf\" with you.", daysAgo: 3 },
  { actor: teamId(15), verb: "drive.file.uploaded",     objectType: "object",   objectIdFn: () => uid("f000", 41), summary: "Omar Hassan uploaded \"postgres-upgrade-plan.pdf\".", daysAgo: 1 },
  { actor: teamId(5),  verb: "drive.file.shared",       objectType: "object",   objectIdFn: () => uid("f000", 55), summary: "Evan Brooks shared \"okr-q3-tracking.csv\" with you.", daysAgo: 2 },
  { actor: teamId(18), verb: "drive.file.uploaded",     objectType: "object",   objectIdFn: () => uid("f000", 124), summary: "Rosa Kim uploaded \"monthly-metrics-may.pdf\".", daysAgo: 0 },

  // Calendar activity
  { actor: teamId(8),  verb: "calendar.event.invited",  objectType: "event",    objectIdFn: () => uid("d200", 7),  summary: "Hannah Price invited you to \"Sprint planning\".", daysAgo: 0 },
  { actor: teamId(4),  verb: "calendar.event.invited",  objectType: "event",    objectIdFn: () => uid("d200", 19), summary: "Diana Singh invited you to \"Roadmap review — Q3\".", daysAgo: 1 },
  { actor: teamId(13), verb: "calendar.event.invited",  objectType: "event",    objectIdFn: () => uid("d200", 23), summary: "Marco Vitale invited you to \"Northwind QBR\".", daysAgo: 2 },
  { actor: teamId(22), verb: "calendar.event.invited",  objectType: "event",    objectIdFn: () => uid("d200", 32), summary: "Vera Stone invited you to \"Engineering hiring day\".", daysAgo: 3 },
  { actor: teamId(8),  verb: "calendar.event.updated",  objectType: "event",    objectIdFn: () => uid("d200", 3),  summary: "Hannah Price updated \"All-hands\" — new location.", daysAgo: 4 },
  { actor: teamId(6),  verb: "calendar.event.invited",  objectType: "event",    objectIdFn: () => uid("d200", 18), summary: "Fiona Marsh invited you to \"User research readout\".", daysAgo: 5 },

  // Chat mentions
  { actor: teamId(2),  verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 2),  summary: "Ben Hayes mentioned you in #engineering.", daysAgo: 0 },
  { actor: teamId(1),  verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 9),  summary: "Alex Torres mentioned you in #backend.", daysAgo: 1 },
  { actor: teamId(4),  verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 3),  summary: "Diana Singh mentioned you in #product.", daysAgo: 1 },
  { actor: teamId(19), verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 4),  summary: "Sam Walker mentioned you in #design.", daysAgo: 2 },
  { actor: teamId(14), verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 7),  summary: "Nina Patel mentioned you in #customer-success.", daysAgo: 3 },
  { actor: teamId(7),  verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 14), summary: "Gabriel Luna mentioned you in #security.", daysAgo: 4 },
  { actor: teamId(9),  verb: "chat.message.mention",    objectType: "thread",   objectIdFn: () => uid("f700", 5),  summary: "Ivan Petrov mentioned you in #infra.", daysAgo: 5 },

  // Meet recordings
  { actor: ADMIN_ACTOR, verb: "meet.recording.attached", objectType: "thread", objectIdFn: () => uid("f700", 3),   summary: "Recording is ready for \"Product weekly\".", daysAgo: 7 },
  { actor: ADMIN_ACTOR, verb: "meet.recording.attached", objectType: "thread", objectIdFn: () => uid("f700", 9),   summary: "Recording is ready for \"Backend standup\".", daysAgo: 5 },

  // Mail notifications
  { actor: teamId(14), verb: "mail.thread.received",    objectType: "thread",   objectIdFn: () => uid("c000", 26), summary: "New customer mail: Northwind re: onboarding timeline.", daysAgo: 0 },
  { actor: teamId(12), verb: "mail.thread.received",    objectType: "thread",   objectIdFn: () => uid("c000", 116), summary: "Legal: contract review request for Northwind.", daysAgo: 1 },
  { actor: teamId(22), verb: "mail.thread.received",    objectType: "thread",   objectIdFn: () => uid("c000", 246), summary: "Vera Stone: offer discussion update for backend role.", daysAgo: 2 },

  // Sheets activity
  { actor: teamId(5),  verb: "sheets.sheet.shared",     objectType: "sheet",    objectIdFn: () => uid("f200", 4),  summary: "Evan Brooks shared \"Budget Forecast FY2026\" with you.", daysAgo: 1 },
  { actor: teamId(18), verb: "sheets.sheet.shared",     objectType: "sheet",    objectIdFn: () => uid("f200", 6),  summary: "Rosa Kim shared \"Product Analytics — May 2026\" with you.", daysAgo: 2 },
  { actor: teamId(23), verb: "sheets.sheet.shared",     objectType: "sheet",    objectIdFn: () => uid("f200", 10), summary: "Vera Stone shared \"Sprint Tracker — Sprint 24\" with you.", daysAgo: 3 },

  // Slide deck sharing
  { actor: teamId(19), verb: "slides.deck.shared",      objectType: "object",   objectIdFn: () => uid("f500", 4),  summary: "Sam Walker shared \"Drive Browser Redesign — Design Review\" with you.", daysAgo: 2 },
  { actor: teamId(8),  verb: "slides.deck.shared",      objectType: "object",   objectIdFn: () => uid("f500", 3),  summary: "Hannah Price shared \"Engineering All-Hands — Q2 2026\" with you.", daysAgo: 3 },
  { actor: teamId(7),  verb: "slides.deck.shared",      objectType: "object",   objectIdFn: () => uid("f500", 7),  summary: "Gabriel Luna shared \"SOC 2 Audit Preparation\" with you.", daysAgo: 4 },

  // Folder sharing
  { actor: teamId(9),  verb: "drive.folder.shared",     objectType: "folder",   objectIdFn: () => uid("b100", 5),  summary: "Ivan Petrov shared the Infrastructure folder with you.", daysAgo: 5 },
  { actor: teamId(7),  verb: "drive.folder.shared",     objectType: "folder",   objectIdFn: () => uid("b100", 22), summary: "Gabriel Luna shared the Security folder with you.", daysAgo: 6 },

  // Additional doc activity
  { actor: teamId(4),  verb: "docs.document.shared",    objectType: "document", objectIdFn: () => uid("e100", 24), summary: "Diana Singh shared \"Pricing Strategy — Enterprise Tier\" with you.", daysAgo: 6 },
  { actor: teamId(1),  verb: "docs.comment.created",    objectType: "document", objectIdFn: () => uid("e100", 73), summary: "Alex Torres commented on \"Q3 Engineering Roadmap Detail\".", daysAgo: 7 },
  { actor: teamId(11), verb: "docs.document.shared",    objectType: "document", objectIdFn: () => uid("e100", 52), summary: "Kai Nakamura shared \"Mobile Engineering Handbook\" with you.", daysAgo: 7 },
  { actor: teamId(5),  verb: "docs.document.shared",    objectType: "document", objectIdFn: () => uid("e100", 41), summary: "Evan Brooks shared \"Blog Post: Sheets Formula Engine\" with you.", daysAgo: 8 },
];

export async function seedNotifications(sql: SeedSql, orgId: string): Promise<number> {
  let prevHash: string | null = null;

  for (const [i, entry] of ENTRIES.entries()) {
    const objectId = entry.objectIdFn();
    const payload  = { source: WORKSPACE_SEED_LARGE_SOURCE, summary: entry.summary };
    const thisHash = sha(`lg:${orgId}:${entry.verb}:${objectId}:${String(i)}`);

    await sql`
      insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash, created_at)
      values (
        ${orgId}, ${entry.actor}, ${entry.verb}, ${entry.objectType}, ${objectId},
        ${json(sql, payload)}, ${prevHash}, ${thisHash},
        ${daysFromNow(-entry.daysAgo, 10, i % 60)}
      )
      on conflict (this_hash) do nothing
    `;
    prevHash = thisHash;
  }

  return ENTRIES.length;
}
