/**
 * Large workspace seed — optional, runs independently of the light seed.
 *
 * Populates 23 additional teammate actors plus a much richer dataset across
 * every surface:
 *   ~300 mail threads · ~120 cal events · ~150 Drive files
 *   ~80 docs · ~10 sheets · ~10 decks · ~30 chat rooms + ~5000 messages
 *   ~50 activity entries
 *
 * Run with:  pnpm db:seed:workspace:large
 * (run pnpm db:seed:logins && pnpm db:seed:workspace first)
 *
 * Idempotent: re-running produces identical row counts.
 * Source tag: 'workspace-seed-large' — never touches light-seed rows.
 */

import { pathToFileURL } from "node:url";
import { createSqlClient } from "./client.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";
import { clearWorkspaceLarge } from "./seed-workspace-large/clear.js";
import { seedTeammates } from "./seed-workspace-large/teammates.js";
import { seedFolders } from "./seed-workspace-large/folders.js";
import { seedMail } from "./seed-workspace-large/mail.js";
import { seedCalendar } from "./seed-workspace-large/calendar.js";
import { seedDocs } from "./seed-workspace-large/docs.js";
import { seedDrive } from "./seed-workspace-large/drive.js";
import { seedSheets } from "./seed-workspace-large/sheets.js";
import { seedSlides } from "./seed-workspace-large/slides.js";
import { seedChat } from "./seed-workspace-large/chat.js";
import { seedNotifications } from "./seed-workspace-large/notifications.js";

export interface SeedWorkspaceLargeResult {
  readonly orgId: string;
  readonly durationMs: number;
  readonly counts: Record<string, number>;
}

export async function seedWorkspaceLarge(
  orgId: string = DEFAULT_LOCAL_OAUTH_ORG_ID,
): Promise<SeedWorkspaceLargeResult> {
  const t0 = Date.now();
  const sql = createSqlClient();
  const counts: Record<string, number> = {};

  try {
    // Clear previous large-seed data.
    await sql.begin(async (tx) => {
      await clearWorkspaceLarge(tx, orgId);
    });

    // Teammates — must run before surfaces that reference teamId().
    await sql.begin(async (tx) => {
      counts.teammates = await seedTeammates(tx, orgId);
    });

    // Folders — must run before Drive files, docs, sheets, slides.
    await sql.begin(async (tx) => {
      counts.folders = await seedFolders(tx, orgId);
    });

    // All surfaces in parallel-safe individual transactions.
    await sql.begin(async (tx) => {
      counts.mailThreads = await seedMail(tx, orgId);
    });

    await sql.begin(async (tx) => {
      const cal = await seedCalendar(tx, orgId);
      counts.calendars      = cal.calendars;
      counts.calendarEvents = cal.events;
    });

    await sql.begin(async (tx) => {
      counts.docs = await seedDocs(tx, orgId);
    });

    await sql.begin(async (tx) => {
      counts.driveFiles = await seedDrive(tx, orgId);
    });

    await sql.begin(async (tx) => {
      const s = await seedSheets(tx, orgId);
      counts.sheets     = s.sheets;
      counts.sheetTabs  = s.tabs;
      counts.sheetCells = s.cells;
    });

    await sql.begin(async (tx) => {
      const d = await seedSlides(tx, orgId);
      counts.slideDecks = d.decks;
      counts.slides     = d.slides;
    });

    await sql.begin(async (tx) => {
      const c = await seedChat(tx, orgId);
      counts.chatRooms    = c.rooms;
      counts.chatMessages = c.messages;
    });

    await sql.begin(async (tx) => {
      counts.notifications = await seedNotifications(tx, orgId);
    });
  } finally {
    await sql.end();
  }

  return { orgId, durationMs: Date.now() - t0, counts };
}

async function main(): Promise<void> {
  const result = await seedWorkspaceLarge();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
