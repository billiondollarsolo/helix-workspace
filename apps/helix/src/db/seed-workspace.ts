import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import { buildDocsBodyState } from "./seed-docs-body.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";

/**
 * Comprehensive, reusable workspace seed for the Helix web app.
 *
 * Populates a believable "Helix" company workspace across every product
 * surface — Mail, Docs, Drive, Calendar, Chat, Sheets, Slides, Meet and the
 * notification/activity feed — owned by (or shared with) the two real login
 * accounts created by `seed-login-accounts.ts`:
 *
 *   * admin@helix.local  — actor 00000000-0000-4000-8000-000000000110 (Avery Park)
 *   * user@helix.local   — actor 00000000-0000-4000-8000-000000000111 (Riley Chen)
 *
 * Both accounts log in to a fully-populated workspace: every owned resource is
 * granted to BOTH actors so either login sees the same rich content.
 *
 * Idempotent / re-runnable: every row this script writes lives under fixed
 * UUIDs in the `0900`/`0a00`..`0f00` group ranges, or carries
 * `metadata.source = 'workspace-seed'`. The seed first deletes everything it
 * previously wrote (in FK-safe order), then re-inserts from scratch, so it is
 * always safe to run repeatedly.
 *
 * Run with:  pnpm db:seed:workspace   (after pnpm db:seed:logins)
 */

export const WORKSPACE_SEED_SOURCE = "workspace-seed";

const ADMIN_ACTOR = "00000000-0000-4000-8000-000000000110";
const USER_ACTOR = "00000000-0000-4000-8000-000000000111";

/** Supporting cast — colleagues referenced as senders / attendees / chat members. */
const TEAM = [
  {
    id: "00000000-0000-4000-8000-000000000a01",
    email: "morgan@helix.local",
    displayName: "Morgan Diaz",
    title: "Head of Product",
  },
  {
    id: "00000000-0000-4000-8000-000000000a02",
    email: "sasha@helix.local",
    displayName: "Sasha Okafor",
    title: "Engineering Lead",
  },
  {
    id: "00000000-0000-4000-8000-000000000a03",
    email: "priya@helix.local",
    displayName: "Priya Raman",
    title: "Design Lead",
  },
  {
    id: "00000000-0000-4000-8000-000000000a04",
    email: "leo@helix.local",
    displayName: "Leo Whitfield",
    title: "Customer Success",
  },
  {
    id: "00000000-0000-4000-8000-000000000a05",
    email: "nadia@helix.local",
    displayName: "Nadia Korhonen",
    title: "Finance Lead",
  },
] as const;

type SeedSql = postgres.Sql | postgres.TransactionSql;

export interface SeedWorkspaceOptions {
  readonly orgId?: string;
}

export interface SeedWorkspaceResult {
  readonly orgId: string;
  readonly counts: Record<string, number>;
}

/** Deterministic uuid in a reserved group so re-runs target the same rows. */
function uid(group: string, index: number): string {
  return `00000000-0000-4000-8000-${group}${index.toString().padStart(8, "0")}`;
}

/** Fixed ids for the seeded org mail labels (the `0b00` group, indices 1..7). */
const MAIL_LABEL_IDS: readonly string[] = Array.from({ length: 7 }, (_, i) => uid("0b00", i + 1));

function json(sql: SeedSql, value: postgres.JSONValue): postgres.Parameter {
  return sql.json(value);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Anchor "now" used to spread content across past + future weeks. */
const NOW = new Date("2026-05-21T16:00:00.000Z");
function daysFromNow(days: number, hour = 9, minute = 0): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// ===========================================================================
// Cleanup — remove everything a prior run of this seed wrote, FK-safe order.
// ===========================================================================

async function clearWorkspace(sql: SeedSql, orgId: string): Promise<void> {
  // Collect thread ids owned by this seed (covers mail, chat, doc, calendar, call).
  const seededThreads = await sql<{ readonly id: string }[]>`
    select id from threads
    where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}
  `;
  const threadIds = seededThreads.map((r) => r.id);
  const seededObjects = await sql<{ readonly id: string }[]>`
    select id from objects
    where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}
  `;
  const objectIds = seededObjects.map((r) => r.id);

  // OID 2950 = uuid — keeps array binding typed so `= any(...)` matches uuid columns.
  const UUID_OID = 2950;
  const inThreads = sql.array(threadIds.length > 0 ? threadIds : [orgId], UUID_OID);
  const inObjects = sql.array(objectIds.length > 0 ? objectIds : [orgId], UUID_OID);
  const grantActors = sql.array([ADMIN_ACTOR, USER_ACTOR], UUID_OID);

  // Permissions referencing any seeded resource.
  await sql`delete from permissions where org_id = ${orgId} and granted_by_actor_id = any(${grantActors}) and resource_id = any(${inThreads})`;
  await sql`delete from permissions where org_id = ${orgId} and granted_by_actor_id = any(${grantActors}) and resource_id = any(${inObjects})`;
  // Meet/calendar/sheet/slide/document resource permissions are keyed on ids
  // outside the thread/object sets above — clear them by resource id range.
  await sql`delete from permissions where org_id = ${orgId} and granted_by_actor_id = any(${grantActors}) and resource_type in ('calendar','event','document','sheet','slide_deck','meet_room','folder')`;

  // Meet.
  await sql`delete from meet_rooms where org_id = ${orgId} and thread_id = any(${inThreads})`;
  // Chat.
  await sql`delete from chat_reactions where org_id = ${orgId} and message_id in (select id from messages where thread_id = any(${inThreads}))`;
  await sql`delete from chat_pins where org_id = ${orgId} and thread_id = any(${inThreads})`;
  await sql`delete from chat_read_receipts where org_id = ${orgId} and thread_id = any(${inThreads})`;
  await sql`delete from chat_room_settings where org_id = ${orgId} and thread_id = any(${inThreads})`;
  // Calendar.
  await sql`delete from cal_calendar_memberships where org_id = ${orgId} and calendar_id in (select id from cal_calendars where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from cal_attendees where org_id = ${orgId} and event_id in (select id from cal_events where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from cal_events where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  await sql`delete from cal_calendars where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  // Docs.
  await sql`delete from docs_comments where org_id = ${orgId} and document_id in (select id from docs_documents where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from docs_updates where org_id = ${orgId} and document_id in (select id from docs_documents where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from docs_documents where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  // Sheets.
  await sql`delete from sheet_cells where org_id = ${orgId} and sheet_tab_id in (select t.id from sheet_tabs t join sheets s on s.id = t.sheet_id where s.org_id = ${orgId} and s.metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from sheet_tabs where org_id = ${orgId} and sheet_id in (select id from sheets where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from sheets where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  // Slides.
  await sql`delete from slides where org_id = ${orgId} and deck_id in (select id from slide_decks where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE})`;
  await sql`delete from slide_decks where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  // Mail / messages / threads.
  await sql`delete from message_attachments where message_id in (select id from messages where thread_id = any(${inThreads}))`;
  await sql`delete from mail_thread_state where org_id = ${orgId} and thread_id = any(${inThreads})`;
  await sql`delete from mail_labels where org_id = ${orgId} and id = any(${sql.array([...MAIL_LABEL_IDS], UUID_OID)})`;
  await sql`delete from messages where thread_id = any(${inThreads})`;
  // Drive versions + objects.
  await sql`delete from drive_versions where org_id = ${orgId} and object_id = any(${inObjects})`;
  await sql`delete from objects where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  await sql`delete from drive_folders where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  // Activity (notification feed) + threads last.
  await sql`delete from activity where org_id = ${orgId} and payload->>'source' = ${WORKSPACE_SEED_SOURCE}`;
  await sql`delete from threads where org_id = ${orgId} and metadata->>'source' = ${WORKSPACE_SEED_SOURCE}`;
}

// ===========================================================================
// Shared helpers.
// ===========================================================================

/** Grant a resource to BOTH login actors so either account sees it. */
async function grantBoth(
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
    `;
  }
}

async function seedTeam(sql: SeedSql, orgId: string): Promise<void> {
  for (const member of TEAM) {
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes, disabled_at, metadata)
      values (
        ${member.id}, ${orgId}, 'user', ${member.email}, ${member.displayName},
        ${sql.array(["platform.read", "mail.read", "chat.read", "calendar.read", "docs.read"], 1009)},
        null,
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, title: member.title })}
      )
      on conflict (id) do update
      set org_id = excluded.org_id, email = excluded.email,
          display_name = excluded.display_name, disabled_at = null,
          metadata = actors.metadata || excluded.metadata, updated_at = now()
    `;
  }
}

// ===========================================================================
// Mail — ~32 threads across folders, categories, labels, attachments.
// ===========================================================================

interface MailThreadSpec {
  readonly idx: number;
  readonly subject: string;
  readonly from: { readonly address: string; readonly name: string };
  readonly category: "primary" | "updates" | "promotions" | "social";
  readonly labels: readonly string[];
  readonly bodies: readonly string[];
  readonly daysAgo: number;
  readonly read: boolean;
  readonly starred?: boolean;
  readonly archived?: boolean;
  readonly snoozedDays?: number;
  readonly draft?: boolean;
  readonly sent?: boolean;
  readonly hasAttachment?: boolean;
}

function mailThreadSpecs(): readonly MailThreadSpec[] {
  return [
    {
      idx: 1,
      subject: "Welcome to Helix — your workspace is ready",
      from: { address: "team@helix.local", name: "The Helix Team" },
      category: "updates",
      labels: ["inbox", "important"],
      daysAgo: 14,
      read: true,
      bodies: [
        "Welcome aboard! Your Helix workspace is fully provisioned and ready to go.\n\nHelix brings Mail, Calendar, Drive, Docs, Sheets, Slides, Chat, and Meet into one place. Everything is connected: a calendar invite can spin up a Meet room, a document can be attached straight from Drive, and the assistant can act across all of it.\n\nWe recommend starting with the onboarding checklist in Docs, then inviting the rest of your team. If anything looks off, reply to this thread and someone from our team will jump in.",
      ],
    },
    {
      idx: 2,
      subject: "Q3 roadmap review — agenda and pre-reads",
      from: { address: "morgan@helix.local", name: "Morgan Diaz" },
      category: "primary",
      labels: ["inbox", "important", "project-helix"],
      daysAgo: 2,
      read: false,
      starred: true,
      bodies: [
        "Hi all,\n\nWe're locking the Q3 roadmap on Friday. Before then, please review the planning doc and leave comments on anything you'd push back on.\n\nThe three big bets on the table are: deeper assistant automation, the Sheets formula engine, and a Meet recording pipeline. We can't fully fund all three, so come ready to argue priorities.\n\nAgenda is in the calendar invite. See you Thursday.",
        "Thanks Morgan. I've added notes on the Sheets engine — the formula parser is further along than the doc suggests, so I'd argue we can pull that one earlier.\n\nOne open question: do we want the recording pipeline to depend on the new storage tier, or ship it against the current one and migrate later?",
        "Good catch Sasha. Let's ship recording against current storage and migrate in Q4. I'll update the doc before the review.",
      ],
    },
    {
      idx: 3,
      subject: "Re: Customer escalation — Northwind onboarding",
      from: { address: "leo@helix.local", name: "Leo Whitfield" },
      category: "primary",
      labels: ["inbox", "important"],
      daysAgo: 1,
      read: false,
      bodies: [
        "Quick heads-up before standup: Northwind hit a wall importing their legacy mailboxes. The migration tool timed out on their largest mailbox (~80k messages).\n\nThey're a reference account for the enterprise launch, so I'd like eyes on this today. I've reproduced it on staging.",
        "I can take this. Sounds like the batch size on the importer is too aggressive for very large mailboxes — I'll add chunked pagination and a resumable cursor. Should have a fix on staging by end of day.",
      ],
    },
    {
      idx: 4,
      subject: "Your invoice from Helix Cloud is available",
      from: { address: "billing@helixcloud.example", name: "Helix Cloud Billing" },
      category: "updates",
      labels: ["inbox", "finance"],
      daysAgo: 5,
      read: true,
      hasAttachment: true,
      bodies: [
        "Your invoice for the May billing period is now available.\n\nAmount due: $1,284.00\nDue date: June 1, 2026\n\nThe full invoice is attached as a PDF. You can also view billing history and update payment details from the billing console. Thank you for being a Helix Cloud customer.",
      ],
    },
    {
      idx: 5,
      subject: "[helix/platform] PR #482 — Fix mail importer pagination",
      from: { address: "notifications@github.com", name: "GitHub" },
      category: "updates",
      labels: ["inbox", "engineering"],
      daysAgo: 0,
      read: false,
      bodies: [
        "Sasha Okafor opened pull request #482 in helix/platform.\n\n  Fix mail importer pagination for very large mailboxes\n\n  Adds a resumable cursor and reduces batch size from 5,000 to 500\n  messages. Tested against an 80k-message mailbox on staging.\n\n  +214 −38 across 6 files\n\nReview the pull request on GitHub.",
      ],
    },
    {
      idx: 6,
      subject: "Design review notes — Drive file browser refresh",
      from: { address: "priya@helix.local", name: "Priya Raman" },
      category: "primary",
      labels: ["inbox", "design", "project-helix"],
      daysAgo: 3,
      read: true,
      bodies: [
        "Shared the updated Drive browser mockups in the deck. Headline changes:\n\n- Nested folders now expand inline instead of navigating away\n- File type icons are color-coded by category\n- The detail panel shows version history and sharing in one place\n\nI'd love feedback on the breadcrumb behavior at 3+ levels deep — it gets crowded. Notes welcome on the slides directly.",
      ],
    },
    {
      idx: 7,
      subject: "Lunch & learn: the new assistant tooling",
      from: { address: "morgan@helix.local", name: "Morgan Diaz" },
      category: "primary",
      labels: ["inbox"],
      daysAgo: 4,
      read: true,
      bodies: [
        "Sasha is running a lunch & learn on Thursday about the assistant tool registry — how tools are declared, how confirmation gating works, and how to add a new one.\n\nGreat session if you've ever wanted the assistant to do something it currently can't. Lunch provided. Room booked, calendar invite to follow.",
      ],
    },
    {
      idx: 8,
      subject: "50% off all annual plans — this week only",
      from: { address: "marketing@cloudtools.example", name: "CloudTools Team" },
      category: "promotions",
      labels: ["inbox"],
      daysAgo: 2,
      read: false,
      bodies: [
        "For a limited time, save 50% on every annual CloudTools plan.\n\nThis is our biggest sale of the year — upgrade now and lock in the discount for 12 months. Offer ends Sunday at midnight.\n\nUnsubscribe at any time from the link below.",
      ],
    },
    {
      idx: 9,
      subject: "Priya Raman shared a document with you",
      from: { address: "no-reply@helix.local", name: "Helix Docs" },
      category: "updates",
      labels: ["inbox"],
      daysAgo: 3,
      read: true,
      bodies: [
        'Priya Raman shared the document "Helix Brand Guidelines" with you and gave you comment access.\n\nOpen the document to review and leave feedback.',
      ],
    },
    {
      idx: 10,
      subject: "Morgan Diaz mentioned you in a comment",
      from: { address: "no-reply@helix.local", name: "Helix Docs" },
      category: "updates",
      labels: ["inbox"],
      daysAgo: 1,
      read: false,
      bodies: [
        'Morgan Diaz mentioned you in a comment on "Q3 Roadmap & Planning":\n\n  "@you — can you confirm the engineering estimate for the Sheets\n  formula engine before Friday\'s review?"\n\nReply from the document to continue the conversation.',
      ],
    },
    {
      idx: 11,
      subject: "You have a new connection request",
      from: { address: "invitations@linkedin.com", name: "LinkedIn" },
      category: "social",
      labels: ["inbox"],
      daysAgo: 6,
      read: true,
      bodies: [
        "Alex Rivera, Staff Engineer at Northwind, would like to connect with you on LinkedIn.\n\nView profile and respond to the invitation.",
      ],
    },
    {
      idx: 12,
      subject: "Reminder: submit your May expense report",
      from: { address: "nadia@helix.local", name: "Nadia Korhonen" },
      category: "primary",
      labels: ["inbox", "finance"],
      daysAgo: 1,
      read: false,
      bodies: [
        "Friendly reminder that May expense reports are due by the end of the week.\n\nPlease itemize anything over $25 and attach receipts. The expense tracker sheet has been shared with you — just add your rows to the May tab. Reach out if you need a category that isn't listed.",
      ],
    },
    {
      idx: 13,
      subject: "Helix status: scheduled maintenance this weekend",
      from: { address: "status@helix.local", name: "Helix Status" },
      category: "updates",
      labels: ["inbox"],
      daysAgo: 4,
      read: true,
      bodies: [
        "We have scheduled maintenance for Saturday 02:00–04:00 UTC.\n\nDuring this window, Drive uploads and Meet recordings may be briefly unavailable. Mail, Calendar, and Chat will continue to operate normally. No action is required on your part.",
      ],
    },
    {
      idx: 14,
      subject: "Weekly newsletter: what shipped in product",
      from: { address: "newsletter@helix.local", name: "Helix Product" },
      category: "promotions",
      labels: ["inbox"],
      daysAgo: 7,
      read: true,
      bodies: [
        "Here's what shipped this week across the Helix platform:\n\n- Mail now groups your inbox into Primary, Updates, Promotions, and Social\n- Calendar gained shared team calendars with per-person color overrides\n- The Sheets formula engine entered private beta\n\nFull changelog and a short demo video are on the product blog.",
      ],
    },
    {
      idx: 15,
      subject: "Re: Offsite planning — venue shortlist",
      from: { address: "leo@helix.local", name: "Leo Whitfield" },
      category: "primary",
      labels: ["inbox", "team"],
      daysAgo: 8,
      read: true,
      bodies: [
        "I've narrowed the offsite venue list to three options. All within budget and big enough for the whole team.\n\n1. Lakeside Lodge — best for outdoor activities, 90 min drive\n2. The Foundry — downtown, walkable, great for workshops\n3. Cedar Barn — most scenic, but limited A/V for sessions\n\nVotes welcome. I'll book by Friday.",
        "The Foundry gets my vote — walkability matters more than scenery when half the days are workshops.",
      ],
    },
    {
      idx: 16,
      subject: "Your package has shipped",
      from: { address: "ship-confirm@parcelco.example", name: "ParcelCo" },
      category: "updates",
      labels: ["inbox"],
      daysAgo: 2,
      read: true,
      bodies: [
        "Good news — your order has shipped and is on its way.\n\nEstimated delivery: Friday\nTracking number: PC-9X42-7781\n\nYou'll get another email when it's out for delivery.",
      ],
    },
    {
      idx: 17,
      subject: "Security alert: new sign-in to your account",
      from: { address: "security@helix.local", name: "Helix Security" },
      category: "updates",
      labels: ["inbox", "important"],
      daysAgo: 5,
      read: true,
      bodies: [
        "We noticed a new sign-in to your Helix account.\n\nDevice: Chrome on macOS\nLocation: approximate, based on IP\nTime: May 16, 2026\n\nIf this was you, no action is needed. If you don't recognize this activity, change your password immediately and review active sessions in settings.",
      ],
    },
    {
      idx: 18,
      subject: "Customer feedback roundup — April",
      from: { address: "leo@helix.local", name: "Leo Whitfield" },
      category: "primary",
      labels: ["inbox", "team"],
      daysAgo: 10,
      read: true,
      bodies: [
        "April feedback themes from support tickets and calls:\n\n- Strong demand for keyboard shortcuts across Mail and Drive\n- Several requests for offline access to Docs\n- Recurring confusion around sharing permissions wording\n\nI've logged the top items as issues. The permissions wording is the quickest win — Priya already has mockups.",
      ],
    },
    {
      idx: 19,
      subject: "Invitation: join the Helix beta community",
      from: { address: "community@helix.local", name: "Helix Community" },
      category: "social",
      labels: ["inbox"],
      daysAgo: 9,
      read: true,
      bodies: [
        "You're invited to the Helix beta community — a space to share feedback, swap tips, and talk directly with the team building the product.\n\nWeekly office hours, early feature previews, and a friendly crowd. Join from the link below.",
      ],
    },
    {
      idx: 20,
      subject: "Contract renewal — Northwind enterprise agreement",
      from: { address: "nadia@helix.local", name: "Nadia Korhonen" },
      category: "primary",
      labels: ["inbox", "finance", "important"],
      daysAgo: 6,
      read: true,
      hasAttachment: true,
      bodies: [
        "The Northwind enterprise agreement is up for renewal next month. I've attached the draft renewal terms — usage has grown ~40% year over year, so the new tier reflects that.\n\nLegal has reviewed clause 7 (data residency). Once you've looked it over, I'll send it to their procurement contact.",
      ],
    },
    {
      idx: 21,
      subject: "Re: Hiring — backend engineer loop feedback",
      from: { address: "sasha@helix.local", name: "Sasha Okafor" },
      category: "primary",
      labels: ["inbox", "hiring"],
      daysAgo: 3,
      read: false,
      bodies: [
        "Wrapping up feedback for yesterday's backend candidate. Strong on systems design — walked through a clean sharding strategy without prompting. Coding round was solid if a little slow.\n\nMy lean is hire. Curious where the rest of the loop landed before we sync.",
        "Agreed on hire. The design discussion was the best I've seen this cycle. Slow coding doesn't worry me given the role is senior.",
      ],
    },
    {
      idx: 22,
      subject: "Early bird pricing ends soon — DevConf 2026",
      from: { address: "marketing@devconf.example", name: "DevConf Team" },
      category: "promotions",
      labels: ["inbox"],
      daysAgo: 4,
      read: true,
      bodies: [
        "Early bird registration for DevConf 2026 ends this Friday.\n\nThree days of talks on distributed systems, developer tooling, and AI. Save $300 by registering before the deadline. Group discounts available for teams of five or more.",
      ],
    },
    {
      idx: 23,
      subject: 'Doc comment resolved: "Onboarding Checklist"',
      from: { address: "no-reply@helix.local", name: "Helix Docs" },
      category: "updates",
      labels: ["inbox"],
      daysAgo: 2,
      read: true,
      bodies: [
        'A comment thread you participated in on "New Hire Onboarding Checklist" has been marked resolved by Priya Raman.\n\nOpen the document to see the final state.',
      ],
    },
    {
      idx: 24,
      subject: "Team lunch Friday — count me in?",
      from: { address: "priya@helix.local", name: "Priya Raman" },
      category: "primary",
      labels: ["inbox", "team"],
      daysAgo: 1,
      read: false,
      bodies: [
        "Organizing a team lunch Friday at the noodle place near the office — the one everyone keeps asking to go back to.\n\nReply with a yes/no so I can put in the reservation. Aiming for 12:30.",
      ],
    },
    {
      idx: 25,
      subject: "Your calendar: 3 events tomorrow",
      from: { address: "no-reply@helix.local", name: "Helix Calendar" },
      category: "updates",
      labels: ["inbox"],
      daysAgo: 0,
      read: false,
      bodies: [
        "Here's your day tomorrow:\n\n  09:00  Daily standup\n  13:00  Q3 roadmap review\n  16:00  1:1 with Morgan\n\nHave a productive day. View the full calendar for details and join links.",
      ],
    },
    // Sent.
    {
      idx: 26,
      subject: "Status update — mail importer fix",
      from: { address: "user@helix.local", name: "Riley Chen" },
      category: "primary",
      labels: ["sent"],
      daysAgo: 0,
      read: true,
      sent: true,
      bodies: [
        "Sending a quick status update on the Northwind importer issue.\n\nThe fix is on staging: chunked pagination with a resumable cursor. I re-ran the 80k-message import end to end and it completed in about nine minutes with no timeouts.\n\nPlanning to ship to production tomorrow after one more review pass. I'll confirm here once it's out.",
      ],
    },
    {
      idx: 27,
      subject: "Re: Q3 roadmap review — agenda and pre-reads",
      from: { address: "user@helix.local", name: "Riley Chen" },
      category: "primary",
      labels: ["sent"],
      daysAgo: 1,
      read: true,
      sent: true,
      bodies: [
        "Thanks Morgan — I've read through the planning doc.\n\nMy main note is on sequencing: if we ship the recording pipeline against current storage, we should budget time in Q4 for the migration rather than leaving it implicit. I left a comment on that section.\n\nOtherwise the priorities look right to me. See everyone Thursday.",
      ],
    },
    // Drafts.
    {
      idx: 28,
      subject: "Draft: onboarding feedback for new hires",
      from: { address: "user@helix.local", name: "Riley Chen" },
      category: "primary",
      labels: ["drafts"],
      daysAgo: 0,
      read: true,
      draft: true,
      bodies: [
        "A few notes on the onboarding experience while it's fresh, from the perspective of someone who just went through it:\n\n- The Docs checklist is genuinely helpful — keep it\n- Drive permissions were the most confusing part on day one\n- A short Meet walkthrough video would have saved me an hour\n\n(still drafting — want to add the chat setup section before sending)",
      ],
    },
    {
      idx: 29,
      subject: "Draft: proposal for keyboard shortcuts",
      from: { address: "user@helix.local", name: "Riley Chen" },
      category: "primary",
      labels: ["drafts"],
      daysAgo: 2,
      read: true,
      draft: true,
      bodies: [
        "Customers keep asking for keyboard shortcuts across Mail and Drive. Sketching a proposal here.\n\nProposed first set: j/k to move between rows, e to archive, x to select, / to focus search. These match what people already expect from other tools, so the learning curve is near zero.\n\n(needs a section on discoverability before this goes out)",
      ],
    },
    // Archived.
    {
      idx: 30,
      subject: "Re: Welcome lunch — thanks everyone",
      from: { address: "morgan@helix.local", name: "Morgan Diaz" },
      category: "primary",
      labels: ["team"],
      daysAgo: 21,
      read: true,
      archived: true,
      bodies: [
        "Just wanted to say thanks to everyone who came to the welcome lunch for our new teammates. Great turnout and a nice way to start the week.\n\nArchiving this thread — see you all at standup.",
      ],
    },
    {
      idx: 31,
      subject: "Old project wrap-up — legacy mail migration",
      from: { address: "sasha@helix.local", name: "Sasha Okafor" },
      category: "primary",
      labels: ["engineering"],
      daysAgo: 28,
      read: true,
      archived: true,
      bodies: [
        "The legacy mail migration project is officially wrapped. All historical mailboxes are imported and verified, and the old system has been decommissioned.\n\nThanks to everyone who pitched in. Archiving this thread for the record.",
      ],
    },
    // Snoozed.
    {
      idx: 32,
      subject: "Follow up: enterprise launch checklist",
      from: { address: "morgan@helix.local", name: "Morgan Diaz" },
      category: "primary",
      labels: ["inbox", "important"],
      daysAgo: 3,
      read: true,
      snoozedDays: 2,
      bodies: [
        "Snoozing this back to the top of your inbox closer to the launch.\n\nThe enterprise launch checklist still has three open items: the recording pipeline sign-off, the data residency doc, and the updated pricing page. Let's make sure all three are green before we announce.",
      ],
    },
  ];
}

async function seedMail(sql: SeedSql, orgId: string): Promise<number> {
  // Org labels with colors.
  const labels = [
    { slug: "important", name: "Important", color: "#ea4335" },
    { slug: "project-helix", name: "Project Helix", color: "#1a73e8" },
    { slug: "finance", name: "Finance", color: "#137333" },
    { slug: "engineering", name: "Engineering", color: "#9334e6" },
    { slug: "design", name: "Design", color: "#e8710a" },
    { slug: "team", name: "Team", color: "#12b5cb" },
    { slug: "hiring", name: "Hiring", color: "#f9ab00" },
  ];
  for (const [i, label] of labels.entries()) {
    await sql`
      insert into mail_labels (id, org_id, owner_actor_id, slug, name, color, sort_order)
      values (
        ${uid("0b00", i + 1)}, ${orgId}, null, ${label.slug}, ${label.name},
        ${label.color}, ${(i + 1) * 10}
      )
    `;
  }

  const specs = mailThreadSpecs();
  for (const spec of specs) {
    const threadId = uid("0c00", spec.idx);
    const sentAt = daysFromNow(-spec.daysAgo, 8 + (spec.idx % 9), (spec.idx * 7) % 60);
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'mail', ${spec.subject}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, messageId: `<${threadId}@helix.local>` })})
    `;
    const ownTo = [
      { address: "admin@helix.local", name: "Avery Park" },
      { address: "user@helix.local", name: "Riley Chen" },
    ];
    for (const [mi, body] of spec.bodies.entries()) {
      const messageId = uid("0d00", spec.idx * 10 + mi);
      const direction = spec.sent === true || spec.draft === true ? "outbound" : "inbound";
      const msgSentAt = new Date(sentAt.getTime() + mi * 3_600_000);
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${messageId}, ${orgId}, ${threadId}, ${ADMIN_ACTOR}, 'mail', ${body}, 'plain',
          ${json(sql, {
            source: WORKSPACE_SEED_SOURCE,
            direction,
            from: spec.from,
            to: ownTo,
            cc: [],
            bcc: [],
            subject: mi === 0 ? spec.subject : `Re: ${spec.subject}`,
            messageId: `<${messageId}@helix.local>`,
            inReplyTo: mi === 0 ? null : `<${uid("0d00", spec.idx * 10 + mi - 1)}@helix.local>`,
            references: [],
          })},
          ${msgSentAt}
        )
      `;
      // Attachment on the first message of flagged threads.
      if (spec.hasAttachment === true && mi === 0) {
        const objectId = uid("0e00", spec.idx);
        const attBody = `Attachment for "${spec.subject}".\n\nThis is a seeded PDF placeholder representing the document referenced in the email above.`;
        await sql`
          insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
          values (
            ${objectId}, ${orgId}, ${ADMIN_ACTOR}, 'mail_attachment',
            ${`mail/${objectId}/document.pdf`}, 'application/pdf',
            ${Buffer.byteLength(attBody, "utf8")}, ${sha(attBody)},
            ${json(sql, { source: WORKSPACE_SEED_SOURCE, filename: spec.idx === 4 ? "invoice-may-2026.pdf" : "northwind-renewal-terms.pdf", contentId: null })}
          )
        `;
        await sql`
          insert into message_attachments (message_id, object_id, disposition)
          values (${messageId}, ${objectId}, 'attachment')
        `;
        await grantBoth(sql, orgId, "object", objectId, "owner");
      }
    }
    // Per-actor thread state for BOTH login actors.
    for (const actorId of [ADMIN_ACTOR, USER_ACTOR]) {
      await sql`
        insert into mail_thread_state (
          actor_id, thread_id, org_id, labels, archived_at, deleted_at,
          snoozed_until, read_at, starred, category, updated_at
        )
        values (
          ${actorId}, ${threadId}, ${orgId}, ${sql.array([...spec.labels])},
          ${spec.archived === true ? sentAt : null},
          null,
          ${spec.snoozedDays !== undefined ? daysFromNow(spec.snoozedDays) : null},
          ${spec.read ? sentAt : null},
          ${spec.starred === true},
          ${spec.category},
          now()
        )
      `;
    }
    await grantBoth(sql, orgId, "thread", threadId, "owner");
  }
  return specs.length;
}

// ===========================================================================
// Drive — nested folder tree (3+ levels) + ~22 files of varied types.
// ===========================================================================

interface DriveFileSpec {
  readonly idx: number;
  readonly name: string;
  readonly folder: number | null;
  readonly mime: string;
  readonly kb: number;
  readonly daysAgo: number;
  readonly shared?: boolean;
}

async function seedDrive(sql: SeedSql, orgId: string): Promise<{ folders: number; files: number }> {
  // Folder tree: indexes 1..9.
  //  1 Helix Workspace
  //    2 Product           (parent 1)
  //      3 Roadmap         (parent 2)
  //      4 Research        (parent 2)
  //    5 Engineering       (parent 1)
  //      6 Design Docs     (parent 5)
  //    7 Finance           (parent 1)
  //    8 Marketing         (parent 1)
  //  9 Shared with Me      (root)
  const folders: { idx: number; name: string; parent: number | null; color: string }[] = [
    { idx: 1, name: "Helix Workspace", parent: null, color: "blue" },
    { idx: 2, name: "Product", parent: 1, color: "green" },
    { idx: 3, name: "Roadmap", parent: 2, color: "purple" },
    { idx: 4, name: "Research", parent: 2, color: "orange" },
    { idx: 5, name: "Engineering", parent: 1, color: "red" },
    { idx: 6, name: "Design Docs", parent: 5, color: "teal" },
    { idx: 7, name: "Finance", parent: 1, color: "green" },
    { idx: 8, name: "Marketing", parent: 1, color: "yellow" },
    { idx: 9, name: "Shared with Me", parent: null, color: "gray" },
  ];
  for (const f of folders) {
    await sql`
      insert into drive_folders (id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata)
      values (
        ${uid("0f00", f.idx)}, ${orgId}, ${f.name},
        ${f.parent === null ? null : uid("0f00", f.parent)},
        ${ADMIN_ACTOR}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, color: f.color })}
      )
    `;
    await grantBoth(sql, orgId, "folder", uid("0f00", f.idx), "owner");
  }

  const files: DriveFileSpec[] = [
    {
      idx: 1,
      name: "Q3 Roadmap.helixdoc",
      folder: 3,
      mime: "application/vnd.helix.document",
      kb: 42,
      daysAgo: 2,
    },
    {
      idx: 2,
      name: "Roadmap Tracker.helixsheet",
      folder: 3,
      mime: "application/vnd.helix.sheet",
      kb: 88,
      daysAgo: 1,
    },
    {
      idx: 3,
      name: "Feature Prioritization.pdf",
      folder: 3,
      mime: "application/pdf",
      kb: 312,
      daysAgo: 5,
    },
    {
      idx: 4,
      name: "User Interviews — April.pdf",
      folder: 4,
      mime: "application/pdf",
      kb: 540,
      daysAgo: 12,
    },
    {
      idx: 5,
      name: "Survey Results.helixsheet",
      folder: 4,
      mime: "application/vnd.helix.sheet",
      kb: 124,
      daysAgo: 9,
    },
    {
      idx: 6,
      name: "Competitor Analysis.helixdoc",
      folder: 4,
      mime: "application/vnd.helix.document",
      kb: 67,
      daysAgo: 14,
      shared: true,
    },
    {
      idx: 7,
      name: "Architecture Overview.helixdoc",
      folder: 5,
      mime: "application/vnd.helix.document",
      kb: 95,
      daysAgo: 6,
    },
    { idx: 8, name: "Service Diagram.png", folder: 5, mime: "image/png", kb: 880, daysAgo: 6 },
    {
      idx: 9,
      name: "On-call Runbook.pdf",
      folder: 5,
      mime: "application/pdf",
      kb: 220,
      daysAgo: 3,
    },
    {
      idx: 10,
      name: "Drive Browser Mockups.png",
      folder: 6,
      mime: "image/png",
      kb: 1_640,
      daysAgo: 3,
      shared: true,
    },
    {
      idx: 11,
      name: "Design System.helixdoc",
      folder: 6,
      mime: "application/vnd.helix.document",
      kb: 73,
      daysAgo: 7,
    },
    {
      idx: 12,
      name: "Component Library.helixslides",
      folder: 6,
      mime: "application/vnd.helix.slides",
      kb: 2_100,
      daysAgo: 4,
    },
    { idx: 13, name: "May Invoice.pdf", folder: 7, mime: "application/pdf", kb: 96, daysAgo: 5 },
    {
      idx: 14,
      name: "Expense Tracker 2026.helixsheet",
      folder: 7,
      mime: "application/vnd.helix.sheet",
      kb: 156,
      daysAgo: 1,
    },
    {
      idx: 15,
      name: "Budget Forecast.helixsheet",
      folder: 7,
      mime: "application/vnd.helix.sheet",
      kb: 204,
      daysAgo: 8,
    },
    {
      idx: 16,
      name: "Northwind Renewal Terms.pdf",
      folder: 7,
      mime: "application/pdf",
      kb: 188,
      daysAgo: 6,
      shared: true,
    },
    {
      idx: 17,
      name: "Brand Guidelines.pdf",
      folder: 8,
      mime: "application/pdf",
      kb: 3_400,
      daysAgo: 11,
    },
    {
      idx: 18,
      name: "Launch Announcement.helixdoc",
      folder: 8,
      mime: "application/vnd.helix.document",
      kb: 38,
      daysAgo: 2,
    },
    { idx: 19, name: "Product Demo.mp4", folder: 8, mime: "video/mp4", kb: 48_200, daysAgo: 4 },
    {
      idx: 20,
      name: "Social Media Plan.helixsheet",
      folder: 8,
      mime: "application/vnd.helix.sheet",
      kb: 64,
      daysAgo: 10,
    },
    { idx: 21, name: "Team Photo.jpg", folder: 1, mime: "image/jpeg", kb: 2_750, daysAgo: 20 },
    {
      idx: 22,
      name: "Welcome Packet.pdf",
      folder: 9,
      mime: "application/pdf",
      kb: 410,
      daysAgo: 14,
      shared: true,
    },
  ];
  for (const file of files) {
    const objectId = uid("1000", file.idx);
    const body = `Seeded Drive file: ${file.name}`;
    const created = daysFromNow(-file.daysAgo, 10, file.idx % 60);
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, created_at, updated_at)
      values (
        ${objectId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`drive/${orgId}/${objectId}/${file.name}`}, ${file.mime},
        ${file.kb * 1024}, ${sha(body + String(file.idx))},
        ${json(sql, {
          source: WORKSPACE_SEED_SOURCE,
          name: file.name,
          folderId: file.folder === null ? null : uid("0f00", file.folder),
          status: "ready",
          shared: file.shared === true,
        })},
        ${created}, ${created}
      )
    `;
    await sql`
      insert into drive_versions (id, org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id, created_at)
      values (
        ${uid("1100", file.idx)}, ${orgId}, ${objectId}, 1,
        ${`drive/${orgId}/${objectId}/${file.name}`}, ${file.mime},
        ${file.kb * 1024}, ${sha(body + String(file.idx))},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE })}, ${ADMIN_ACTOR}, ${created}
      )
    `;
    await grantBoth(sql, orgId, "object", objectId, "owner");
  }
  return { folders: folders.length, files: files.length };
}

// ===========================================================================
// Docs — ~9 documents with real prose, plus comments + version history.
// ===========================================================================

interface DocSpec {
  readonly idx: number;
  readonly title: string;
  readonly tags: readonly string[];
  readonly markdown: string;
  readonly versions?: number;
  readonly comments?: readonly {
    readonly actor: string;
    readonly body: string;
    readonly resolved?: boolean;
  }[];
}

/** Folder assignments for docs/sheets/decks — maps content idx to folder idx. */
const DOC_FOLDERS: Readonly<Record<number, number>> = {
  1: 3, // Q3 Roadmap & Planning → Roadmap
  2: 1, // New Hire Onboarding Checklist → Helix Workspace
  3: 8, // Helix Brand Guidelines → Marketing
  4: 5, // Architecture Overview → Engineering
  5: 4, // Customer Feedback Synthesis — April → Research
  6: 5, // On-call Runbook → Engineering
  7: 8, // Launch Announcement — Draft → Marketing
  8: 6, // Design System Reference → Design Docs
  9: 2, // Weekly Team Notes → Product
};
const SHEET_FOLDERS: Readonly<Record<number, number>> = {
  1: 3, // Roadmap Tracker → Roadmap
  2: 7, // Expense Tracker 2026 → Finance
  3: 7, // Budget Forecast → Finance
  4: 4, // Survey Results → Research
};
const DECK_FOLDERS: Readonly<Record<number, number>> = {
  1: 3, // Q3 Roadmap Review → Roadmap
  2: 8, // Helix Enterprise Launch → Marketing
  3: 6, // Design Review — Drive Browser → Design Docs
  4: 2, // Team Offsite Plan → Product
};

function docSpecs(): readonly DocSpec[] {
  return [
    {
      idx: 1,
      title: "Q3 Roadmap & Planning",
      tags: ["planning", "product"],
      versions: 3,
      markdown:
        "# Q3 Roadmap & Planning\n\n## Themes\n\nThis quarter is about depth, not breadth. We have three candidate investments and capacity for roughly two and a half of them.\n\n## Candidate bets\n\n### 1. Assistant automation\nExtend the assistant tool registry so it can chain actions across surfaces — drafting a reply, attaching the right Drive file, and scheduling a follow-up in one confirmed step.\n\n### 2. Sheets formula engine\nShip a real formula engine for Sheets: arithmetic, references, and the twenty most-used functions. The parser is already in private beta and further along than expected.\n\n### 3. Meet recording pipeline\nCapture, store, and transcribe Meet recordings. Decision: ship against current storage and migrate to the new tier in Q4 rather than blocking on it.\n\n## Sequencing\n\nFinance and engineering agree the recording pipeline should not depend on the storage migration. We will budget explicit Q4 time for that migration.\n\n## Open questions\n\n- Final engineering estimate for the formula engine — owner: Sasha\n- Pricing page updates for the enterprise tier — owner: Nadia\n",
      comments: [
        {
          actor: TEAM[0].id,
          body: "@you — can you confirm the engineering estimate for the Sheets formula engine before Friday's review?",
        },
        {
          actor: TEAM[1].id,
          body: "Parser is ~70% done. I'll have a firm number by Thursday.",
          resolved: true,
        },
      ],
    },
    {
      idx: 2,
      title: "New Hire Onboarding Checklist",
      tags: ["onboarding", "people"],
      markdown:
        "# New Hire Onboarding Checklist\n\nWelcome to Helix! Work through this checklist in your first week. Check items off as you go.\n\n## Day 1\n\n- Sign in to your Helix workspace and set a profile photo\n- Read the company handbook in Drive > Helix Workspace\n- Join the #general and #engineering chat spaces\n- Say hello in #general\n\n## Day 2–3\n\n- Pair with your onboarding buddy\n- Set up your local development environment\n- Walk through the architecture overview doc\n- Attend the new-hire Q&A (calendar invite)\n\n## Week 1\n\n- Ship one small change end to end\n- Book a 1:1 with your manager\n- Review the on-call runbook (you won't be on-call yet, but read it)\n\n## Anytime\n\n- Explore Sheets, Slides, and Meet — they're all connected\n- Ask questions early and often\n",
      comments: [
        {
          actor: TEAM[2].id,
          body: "Added the chat spaces step — new folks kept missing it.",
          resolved: true,
        },
      ],
    },
    {
      idx: 3,
      title: "Helix Brand Guidelines",
      tags: ["brand", "design"],
      versions: 2,
      markdown:
        "# Helix Brand Guidelines\n\n## Voice\n\nHelix sounds calm, capable, and direct. We explain things plainly and never oversell. When in doubt, cut a sentence.\n\n## Color\n\nThe primary brand color is Helix Blue (#1a73e8). Use it for primary actions and accents, never for large fills. Secondary palette: green for success, amber for warnings, red for destructive actions.\n\n## Typography\n\nHeadings use the display weight; body copy stays regular. Maintain generous line height — density is for data tables, not prose.\n\n## Logo\n\nKeep clear space around the mark equal to the height of the 'H'. Never recolor, rotate, or add effects to the logo.\n\n## Imagery\n\nPrefer real product screenshots over abstract illustration. Show the software doing real work.\n",
      comments: [{ actor: TEAM[2].id, body: "Should we add a section on dark mode color usage?" }],
    },
    {
      idx: 4,
      title: "Architecture Overview",
      tags: ["engineering", "reference"],
      markdown:
        "# Architecture Overview\n\n## Shape\n\nHelix is a modular monolith. Each product surface — Mail, Drive, Docs, Calendar, Chat, Sheets, Slides, Meet — is a platform module with its own store, tools, and routes, sharing one Postgres database and one object store.\n\n## Data model\n\nThe core tables are `actors`, `threads`, `messages`, `objects`, and `permissions`. Most surfaces hang off `threads`: a mail conversation, a chat room, a doc, and a calendar event are all threads of different kinds.\n\n## Permissions\n\nAuthorization is a single `permissions` table keyed by `(resource_type, resource_id, actor_id, role)`. Every read path joins against it. There is no implicit access.\n\n## Outbox\n\nSide effects — webhooks, email delivery, search indexing — go through a transactional outbox so they are exactly-once with respect to the originating transaction.\n\n## Assistant\n\nThe assistant calls platform tools through a registry. Sensitive tools are gated behind a confirmation step recorded in `pending_actions`.\n",
    },
    {
      idx: 5,
      title: "Customer Feedback Synthesis — April",
      tags: ["research", "customers"],
      markdown:
        "# Customer Feedback Synthesis — April\n\n## Method\n\nSynthesized from 41 support tickets, 6 customer calls, and the in-product feedback widget over the month of April.\n\n## Top themes\n\n### Keyboard shortcuts (mentioned 18x)\nPower users want to fly through Mail and Drive without a mouse. This is the single most-requested improvement.\n\n### Offline Docs (mentioned 11x)\nSeveral customers travel or work with unreliable connectivity and want read access to Docs offline.\n\n### Permissions clarity (mentioned 9x)\nThe wording around sharing — 'can edit' vs 'can comment' vs 'can view' — is confusing. People aren't sure what they're granting.\n\n## Recommended actions\n\n1. Ship a first set of keyboard shortcuts — low effort, high delight\n2. Reword the share dialog — Priya has mockups ready\n3. Scope offline Docs as a larger Q4 investigation\n",
    },
    {
      idx: 6,
      title: "On-call Runbook",
      tags: ["engineering", "operations"],
      markdown:
        "# On-call Runbook\n\n## Before your shift\n\nConfirm you can receive pages, skim recent incidents, and check that no risky deploys are scheduled during your window.\n\n## When paged\n\n1. Acknowledge the page within five minutes\n2. Open the incident channel and post that you're investigating\n3. Check the dashboards before changing anything\n4. Communicate early — a one-line status beats silence\n\n## Common issues\n\n### Mail delivery delays\nUsually the outbound queue backing up. Check the outbox table for stuck rows and the provider status page.\n\n### Drive upload failures\nUsually object storage. Verify the storage endpoint is reachable and the bucket has capacity.\n\n### Slow Calendar queries\nCheck for a missing index after a recent migration.\n\n## After an incident\n\nWrite a short, blameless postmortem within two business days. Focus on the system, not the person.\n",
    },
    {
      idx: 7,
      title: "Launch Announcement — Draft",
      tags: ["marketing", "launch"],
      markdown:
        "# Launch Announcement — Draft\n\n## Headline\n\nHelix for Enterprise is here.\n\n## Body\n\nToday we're launching Helix for Enterprise — the same connected workspace teams already love, now with the controls larger organizations need: data residency options, advanced audit logging, and centralized administration.\n\nEverything stays in one place. Mail, Calendar, Drive, Docs, Sheets, Slides, Chat, and Meet work together, and now your administrators get the visibility and governance to deploy Helix with confidence.\n\n## Call to action\n\nTalk to our team to start an enterprise trial.\n\n## Notes\n\n- Confirm the data residency claim with Legal before publishing\n- Pair with the product demo video\n",
    },
    {
      idx: 8,
      title: "Design System Reference",
      tags: ["design", "reference"],
      markdown:
        "# Design System Reference\n\n## Principles\n\nConsistency over cleverness. A component should behave the same everywhere it appears.\n\n## Spacing\n\nWe use a 4px base unit. All padding and margins are multiples of 4. Dense surfaces (tables, lists) may use the 4px and 8px steps; prose and cards use 16px and up.\n\n## Components\n\n### Buttons\nThree variants: primary, secondary, ghost. One primary action per view.\n\n### Inputs\nAlways paired with a visible label. Placeholder text is never a substitute for a label.\n\n### Surfaces\nCards, panels, and modals share one elevation scale. Don't invent new shadows.\n\n## Accessibility\n\nEvery interactive element is keyboard reachable and has a visible focus state. Color is never the only signal.\n",
    },
    {
      idx: 9,
      title: "Weekly Team Notes",
      tags: ["team", "notes"],
      markdown:
        "# Weekly Team Notes\n\n## This week\n\n- The mail importer fix is on staging and validated against an 80k-message mailbox\n- Drive browser mockups went out for design review\n- The Sheets formula engine entered private beta\n\n## Decisions\n\n- Meet recording pipeline ships against current storage; migration deferred to Q4\n- Offsite venue: The Foundry (walkability won)\n\n## Shoutouts\n\nThanks to Sasha for turning the Northwind escalation around in a day, and to Priya for the brand guidelines refresh.\n\n## Next week\n\n- Q3 roadmap review on Thursday\n- Ship the importer fix to production\n- Start the share-dialog rewording\n",
    },
  ];
}

async function seedDocs(sql: SeedSql, orgId: string): Promise<number> {
  const specs = docSpecs();
  for (const spec of specs) {
    const threadId = uid("1200", spec.idx);
    const documentId = uid("1300", spec.idx);
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'doc', ${spec.title}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
    `;
    // Encode the doc body as a real Yjs document state. The Docs editor
    // renders the `"default"` XmlFragment via Tiptap's Collaboration
    // extension, so raw markdown bytes here would open as an empty editor.
    const body = buildDocsBodyState(spec.markdown);
    await sql`
      insert into docs_documents (id, org_id, title, thread_id, owner_actor_id, created_by_actor_id, ydoc_state, ydoc_state_vector, update_seq, metadata)
      values (
        ${documentId}, ${orgId}, ${spec.title}, ${threadId}, ${ADMIN_ACTOR}, ${ADMIN_ACTOR},
        ${body.state}, ${body.stateVector}, ${spec.versions ?? 0},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, plainText: spec.markdown, tags: [...spec.tags] })}
      )
    `;
    // Shared-PK objects row — makes this doc visible as a Drive entry.
    const docFolderIdx = DOC_FOLDERS[spec.idx];
    const docFolderId = docFolderIdx !== undefined ? uid("0f00", docFolderIdx) : null;
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${documentId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`docs/${orgId}/${documentId}`},
        'application/vnd.helix.document', 0, null,
        ${json(sql, {
          source: WORKSPACE_SEED_SOURCE,
          app: "docs",
          name: spec.title,
          title: spec.title,
          folderId: docFolderId,
        })}
      )
      on conflict (id) do update set
        metadata = excluded.metadata,
        updated_at = now()
    `;
    // Version history — each revision is stored as a valid Yjs update so the
    // append-only `docs_updates` log stays consistent with `ydoc_state`.
    for (let seq = 1; seq <= (spec.versions ?? 0); seq += 1) {
      const revision = buildDocsBodyState(
        `${spec.markdown}\n\nRevision ${String(seq)} — earlier draft.`,
      );
      await sql`
        insert into docs_updates (id, org_id, document_id, actor_id, seq, update, metadata, created_at)
        values (
          ${uid("1400", spec.idx * 10 + seq)}, ${orgId}, ${documentId}, ${ADMIN_ACTOR},
          ${seq}, ${revision.state},
          ${json(sql, { source: WORKSPACE_SEED_SOURCE, summary: `Revision ${String(seq)}` })},
          ${daysFromNow(-(10 - seq), 11)}
        )
      `;
    }
    // Comments.
    for (const [ci, comment] of (spec.comments ?? []).entries()) {
      await sql`
        insert into docs_comments (id, org_id, document_id, actor_id, anchor, body, status, metadata, resolved_at)
        values (
          ${uid("1500", spec.idx * 10 + ci)}, ${orgId}, ${documentId}, ${comment.actor},
          ${json(sql, { blockId: `b${String(ci + 1)}` })}, ${comment.body},
          ${comment.resolved === true ? "resolved" : "open"},
          ${json(sql, { source: WORKSPACE_SEED_SOURCE })},
          ${comment.resolved === true ? daysFromNow(-1, 14) : null}
        )
      `;
    }
    await grantBoth(sql, orgId, "thread", threadId, "owner");
    await grantBoth(sql, orgId, "document", documentId, "owner");
  }
  return specs.length;
}

// ===========================================================================
// Calendar — 3 calendars, ~22 events across weeks (past + future), recurring.
// ===========================================================================

interface EventSpec {
  readonly idx: number;
  readonly calendar: number;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly dayOffset: number;
  readonly startHour: number;
  readonly durationMin: number;
  readonly recurrence?: string;
  readonly attendees?: readonly number[];
}

async function seedCalendar(
  sql: SeedSql,
  orgId: string,
): Promise<{ calendars: number; events: number }> {
  const calendars = [
    { idx: 1, name: "Avery Park", color: "#1a73e8", desc: "Personal calendar" },
    { idx: 2, name: "Helix Team", color: "#137333", desc: "Shared team calendar" },
    { idx: 3, name: "Product", color: "#9334e6", desc: "Product org calendar" },
  ];
  for (const cal of calendars) {
    await sql`
      insert into cal_calendars (id, org_id, owner_actor_id, name, color, timezone, description, metadata)
      values (
        ${uid("1600", cal.idx)}, ${orgId}, ${ADMIN_ACTOR}, ${cal.name}, ${cal.color},
        'America/New_York', ${cal.desc}, ${json(sql, { source: WORKSPACE_SEED_SOURCE })}
      )
    `;
    // Both login actors see all calendars in their sidebar.
    for (const [ai, actorId] of [ADMIN_ACTOR, USER_ACTOR].entries()) {
      await sql`
        insert into cal_calendar_memberships (org_id, calendar_id, actor_id, role, visible, sort_order)
        values (
          ${orgId}, ${uid("1600", cal.idx)}, ${actorId},
          ${actorId === ADMIN_ACTOR ? "owner" : "writer"}, true, ${cal.idx * 10 + ai}
        )
        on conflict (actor_id, calendar_id) do nothing
      `;
    }
    await grantBoth(sql, orgId, "calendar", uid("1600", cal.idx), "owner");
  }

  const events: EventSpec[] = [
    {
      idx: 1,
      calendar: 2,
      title: "Daily standup",
      description: "Quick sync on yesterday, today, and blockers.",
      location: "Meet — Standup Room",
      dayOffset: 0,
      startHour: 9,
      durationMin: 15,
      recurrence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      attendees: [0, 1, 2],
    },
    {
      idx: 2,
      calendar: 3,
      title: "Q3 roadmap review",
      description: "Lock the Q3 roadmap. Pre-read the planning doc and bring priority arguments.",
      location: "Conference Room A",
      dayOffset: 1,
      startHour: 13,
      durationMin: 90,
      attendees: [0, 1, 2, 4],
    },
    {
      idx: 3,
      calendar: 1,
      title: "1:1 with Morgan",
      description: "Weekly one-on-one.",
      location: "Meet",
      dayOffset: 1,
      startHour: 16,
      durationMin: 30,
      attendees: [0],
    },
    {
      idx: 4,
      calendar: 2,
      title: "Lunch & learn: assistant tooling",
      description: "Walkthrough of the assistant tool registry and how to add a new tool.",
      location: "Conference Room B",
      dayOffset: 2,
      startHour: 12,
      durationMin: 60,
      attendees: [1, 2, 3],
    },
    {
      idx: 5,
      calendar: 3,
      title: "Design review — Drive browser",
      description: "Review the refreshed Drive file browser mockups.",
      location: "Meet",
      dayOffset: 3,
      startHour: 11,
      durationMin: 45,
      attendees: [2, 0],
    },
    {
      idx: 6,
      calendar: 2,
      title: "Team lunch",
      description: "Team lunch at the noodle place.",
      location: "Noodle House",
      dayOffset: 3,
      startHour: 12,
      durationMin: 90,
      attendees: [0, 1, 2, 3, 4],
    },
    {
      idx: 7,
      calendar: 1,
      title: "Focus time — importer fix",
      description: "Heads-down work on the mail importer pagination fix.",
      location: "",
      dayOffset: 4,
      startHour: 9,
      durationMin: 120,
    },
    {
      idx: 8,
      calendar: 3,
      title: "Enterprise launch sync",
      description: "Status check on the enterprise launch checklist.",
      location: "Conference Room A",
      dayOffset: 5,
      startHour: 14,
      durationMin: 45,
      attendees: [0, 4],
    },
    {
      idx: 9,
      calendar: 2,
      title: "Sprint planning",
      description: "Plan the next sprint.",
      location: "Conference Room A",
      dayOffset: 7,
      startHour: 10,
      durationMin: 90,
      recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
      attendees: [0, 1, 2],
    },
    {
      idx: 10,
      calendar: 1,
      title: "Dentist appointment",
      description: "Routine checkup.",
      location: "Downtown Dental",
      dayOffset: 8,
      startHour: 15,
      durationMin: 60,
    },
    {
      idx: 11,
      calendar: 3,
      title: "Customer call — Northwind",
      description: "Renewal discussion with Northwind procurement.",
      location: "Meet",
      dayOffset: 9,
      startHour: 13,
      durationMin: 60,
      attendees: [3, 4],
    },
    {
      idx: 12,
      calendar: 2,
      title: "All-hands",
      description: "Monthly all-hands meeting.",
      location: "Main Hall + Meet",
      dayOffset: 10,
      startHour: 16,
      durationMin: 60,
      attendees: [0, 1, 2, 3, 4],
    },
    {
      idx: 13,
      calendar: 2,
      title: "Team offsite",
      description: "Annual team offsite at The Foundry.",
      location: "The Foundry",
      dayOffset: 14,
      startHour: 9,
      durationMin: 480,
      attendees: [0, 1, 2, 3, 4],
    },
    {
      idx: 14,
      calendar: 1,
      title: "Quarterly review prep",
      description: "Prepare materials for the quarterly business review.",
      location: "",
      dayOffset: 18,
      startHour: 10,
      durationMin: 120,
    },
    // Past events.
    {
      idx: 15,
      calendar: 3,
      title: "Q2 retrospective",
      description: "What went well, what didn't, what to change.",
      location: "Conference Room A",
      dayOffset: -7,
      startHour: 14,
      durationMin: 90,
      attendees: [0, 1, 2],
    },
    {
      idx: 16,
      calendar: 2,
      title: "Welcome lunch",
      description: "Welcome lunch for new teammates.",
      location: "Noodle House",
      dayOffset: -14,
      startHour: 12,
      durationMin: 90,
      attendees: [0, 1, 2, 3],
    },
    {
      idx: 17,
      calendar: 1,
      title: "1:1 with Morgan",
      description: "Weekly one-on-one.",
      location: "Meet",
      dayOffset: -6,
      startHour: 16,
      durationMin: 30,
      attendees: [0],
    },
    {
      idx: 18,
      calendar: 3,
      title: "Hiring loop — backend engineer",
      description: "Interview loop for the senior backend role.",
      location: "Meet",
      dayOffset: -3,
      startHour: 10,
      durationMin: 240,
      attendees: [1, 2],
    },
    {
      idx: 19,
      calendar: 2,
      title: "Daily standup",
      description: "Quick sync.",
      location: "Meet — Standup Room",
      dayOffset: -2,
      startHour: 9,
      durationMin: 15,
      attendees: [0, 1, 2],
    },
    {
      idx: 20,
      calendar: 3,
      title: "Design crit",
      description: "Critique of in-progress design work.",
      location: "Conference Room B",
      dayOffset: -5,
      startHour: 15,
      durationMin: 60,
      attendees: [2],
    },
    {
      idx: 21,
      calendar: 1,
      title: "Coffee with Priya",
      description: "Informal catch-up.",
      location: "Café Lumen",
      dayOffset: -9,
      startHour: 10,
      durationMin: 30,
      attendees: [2],
    },
    {
      idx: 22,
      calendar: 2,
      title: "Incident review — mail delays",
      description: "Blameless review of last week's mail delivery incident.",
      location: "Conference Room A",
      dayOffset: -4,
      startHour: 11,
      durationMin: 45,
      attendees: [0, 1],
    },
  ];
  for (const ev of events) {
    const threadId = uid("1700", ev.idx);
    const eventId = uid("1800", ev.idx);
    const startsAt = daysFromNow(ev.dayOffset, ev.startHour, 0);
    const endsAt = new Date(startsAt.getTime() + ev.durationMin * 60_000);
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'calendar', ${ev.title}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
    `;
    await sql`
      insert into cal_events (
        id, org_id, calendar_id, thread_id, uid, title, description, location,
        starts_at, ends_at, timezone, all_day, status, recurrence_rule,
        organizer_actor_id, organizer_email, metadata
      )
      values (
        ${eventId}, ${orgId}, ${uid("1600", ev.calendar)}, ${threadId},
        ${`workspace-event-${String(ev.idx)}@helix.local`}, ${ev.title}, ${ev.description}, ${ev.location},
        ${startsAt}, ${endsAt}, 'America/New_York', false, 'confirmed',
        ${ev.recurrence ?? null}, ${ADMIN_ACTOR}, 'admin@helix.local',
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, visibility: "default" })}
      )
    `;
    // Organizer attendee.
    await sql`
      insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata)
      values (
        ${orgId}, ${eventId}, ${ADMIN_ACTOR}, 'admin@helix.local', 'Avery Park',
        'required', 'accepted', true, ${`rsvp-${eventId}-org`}, ${json(sql, { source: WORKSPACE_SEED_SOURCE })}
      )
    `;
    // user@helix.local attends every event so their calendar is full too.
    await sql`
      insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata)
      values (
        ${orgId}, ${eventId}, ${USER_ACTOR}, 'user@helix.local', 'Riley Chen',
        'required', ${ev.dayOffset < 0 ? "accepted" : ev.idx % 4 === 0 ? "tentative" : "accepted"},
        false, ${`rsvp-${eventId}-user`}, ${json(sql, { source: WORKSPACE_SEED_SOURCE })}
      )
    `;
    for (const teamIdx of ev.attendees ?? []) {
      const member = TEAM[teamIdx];
      if (member === undefined) {
        continue;
      }
      await sql`
        insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata)
        values (
          ${orgId}, ${eventId}, ${member.id}, ${member.email}, ${member.displayName},
          'required', ${ev.dayOffset < 0 ? "accepted" : "needs_action"}, false,
          ${`rsvp-${eventId}-${member.id}`}, ${json(sql, { source: WORKSPACE_SEED_SOURCE })}
        )
      `;
    }
    await grantBoth(sql, orgId, "thread", threadId, "owner");
    await grantBoth(sql, orgId, "event", eventId, "owner");
  }
  return { calendars: calendars.length, events: events.length };
}

// ===========================================================================
// Chat — spaces + DMs with multi-message history, reactions, pins.
// ===========================================================================

interface ChatSpec {
  readonly idx: number;
  readonly kind: "chat_room" | "chat_dm";
  readonly name: string;
  readonly topic: string;
  readonly isPrivate: boolean;
  readonly members: readonly string[];
  readonly messages: readonly {
    readonly actor: string;
    readonly body: string;
    readonly daysAgo: number;
    readonly hour: number;
    readonly minute: number;
  }[];
}

async function seedChat(sql: SeedSql, orgId: string): Promise<{ rooms: number; messages: number }> {
  const specs: ChatSpec[] = [
    {
      idx: 1,
      kind: "chat_room",
      name: "general",
      topic: "Company-wide announcements and watercooler chat.",
      isPrivate: false,
      members: [
        ADMIN_ACTOR,
        USER_ACTOR,
        TEAM[0].id,
        TEAM[1].id,
        TEAM[2].id,
        TEAM[3].id,
        TEAM[4].id,
      ],
      messages: [
        {
          actor: TEAM[0].id,
          body: "Morning everyone! Reminder that the Q3 roadmap review is Thursday — please read the planning doc beforehand.",
          daysAgo: 2,
          hour: 9,
          minute: 2,
        },
        {
          actor: USER_ACTOR,
          body: "Read it last night, left a couple of comments on sequencing. Looks solid overall.",
          daysAgo: 2,
          hour: 9,
          minute: 14,
        },
        {
          actor: TEAM[2].id,
          body: "Drive browser mockups are up in the deck if anyone wants a sneak peek before the design review 👀",
          daysAgo: 2,
          hour: 10,
          minute: 30,
        },
        {
          actor: TEAM[3].id,
          body: "Northwind escalation is resolved — fix is on staging. Huge thanks to Sasha for the fast turnaround.",
          daysAgo: 1,
          hour: 15,
          minute: 5,
        },
        {
          actor: ADMIN_ACTOR,
          body: "Great work all around this week. Team lunch Friday — Priya is taking the reservation, reply to her thread.",
          daysAgo: 1,
          hour: 16,
          minute: 40,
        },
        {
          actor: TEAM[4].id,
          body: "Reminder: May expense reports are due Friday. The tracker sheet is shared with everyone.",
          daysAgo: 0,
          hour: 9,
          minute: 30,
        },
      ],
    },
    {
      idx: 2,
      kind: "chat_room",
      name: "engineering",
      topic: "Engineering discussion, deploys, and incident chatter.",
      isPrivate: false,
      members: [ADMIN_ACTOR, USER_ACTOR, TEAM[1].id],
      messages: [
        {
          actor: TEAM[1].id,
          body: "PR #482 is up — fixes the importer pagination for very large mailboxes. Resumable cursor + smaller batches.",
          daysAgo: 1,
          hour: 11,
          minute: 0,
        },
        {
          actor: USER_ACTOR,
          body: "Reviewing now. Did you test against the full 80k mailbox or a sample?",
          daysAgo: 1,
          hour: 11,
          minute: 12,
        },
        {
          actor: TEAM[1].id,
          body: "Full 80k on staging — completed in ~9 minutes, zero timeouts. Logs in the PR description.",
          daysAgo: 1,
          hour: 11,
          minute: 18,
        },
        {
          actor: USER_ACTOR,
          body: "Nice. Approving. Let's ship to prod tomorrow after one more pass.",
          daysAgo: 1,
          hour: 11,
          minute: 25,
        },
        {
          actor: ADMIN_ACTOR,
          body: "Heads up: scheduled storage maintenance Saturday 02:00–04:00 UTC. Drive uploads + Meet recordings briefly affected.",
          daysAgo: 0,
          hour: 10,
          minute: 0,
        },
      ],
    },
    {
      idx: 3,
      kind: "chat_room",
      name: "design",
      topic: "Design crits, mockups, and the design system.",
      isPrivate: false,
      members: [ADMIN_ACTOR, USER_ACTOR, TEAM[2].id],
      messages: [
        {
          actor: TEAM[2].id,
          body: "Posted the refreshed Drive browser mockups. The breadcrumb at 3+ levels deep still feels crowded — open to ideas.",
          daysAgo: 3,
          hour: 13,
          minute: 0,
        },
        {
          actor: USER_ACTOR,
          body: "What if deep paths collapse the middle segments into a '…' menu? Keeps the first and last visible.",
          daysAgo: 3,
          hour: 13,
          minute: 22,
        },
        {
          actor: TEAM[2].id,
          body: "Oh that's clean. I'll mock that up for the review. Thanks!",
          daysAgo: 3,
          hour: 13,
          minute: 30,
        },
      ],
    },
    {
      idx: 4,
      kind: "chat_room",
      name: "project-helix",
      topic: "Coordination for the enterprise launch.",
      isPrivate: true,
      members: [ADMIN_ACTOR, USER_ACTOR, TEAM[0].id, TEAM[4].id],
      messages: [
        {
          actor: TEAM[0].id,
          body: "Launch checklist has three open items: recording pipeline sign-off, data residency doc, pricing page.",
          daysAgo: 3,
          hour: 14,
          minute: 0,
        },
        {
          actor: TEAM[4].id,
          body: "Pricing page draft is ready for review. Data residency doc is with Legal — expecting it back Wednesday.",
          daysAgo: 3,
          hour: 14,
          minute: 20,
        },
        {
          actor: USER_ACTOR,
          body: "Recording pipeline is on track. I'll have the sign-off checklist filled in by end of week.",
          daysAgo: 2,
          hour: 9,
          minute: 45,
        },
        {
          actor: ADMIN_ACTOR,
          body: "Good. Let's keep this thread tight — status only, discussion in the doc comments.",
          daysAgo: 2,
          hour: 10,
          minute: 0,
        },
      ],
    },
    {
      idx: 5,
      kind: "chat_dm",
      name: "Morgan Diaz",
      topic: "",
      isPrivate: true,
      members: [USER_ACTOR, TEAM[0].id],
      messages: [
        {
          actor: TEAM[0].id,
          body: "Hey — do you have ten minutes before the roadmap review? Want to align on the sequencing point you raised.",
          daysAgo: 1,
          hour: 8,
          minute: 30,
        },
        {
          actor: USER_ACTOR,
          body: "Sure, I'm free at 11. My worry is just that the Q4 migration becomes invisible if we don't write it down now.",
          daysAgo: 1,
          hour: 8,
          minute: 41,
        },
        {
          actor: TEAM[0].id,
          body: "Agreed. I'll add an explicit Q4 line item to the doc before Thursday. 11 works — talk then.",
          daysAgo: 1,
          hour: 8,
          minute: 44,
        },
      ],
    },
    {
      idx: 6,
      kind: "chat_dm",
      name: "Sasha Okafor",
      topic: "",
      isPrivate: true,
      members: [USER_ACTOR, TEAM[1].id],
      messages: [
        {
          actor: USER_ACTOR,
          body: "Approved #482. One tiny nit in the comments about the cursor encoding, non-blocking.",
          daysAgo: 1,
          hour: 11,
          minute: 26,
        },
        {
          actor: TEAM[1].id,
          body: "Thanks! Fixed the nit. Will ship tomorrow morning and post in #engineering.",
          daysAgo: 1,
          hour: 11,
          minute: 40,
        },
      ],
    },
  ];

  let messageCount = 0;
  for (const spec of specs) {
    const threadId = uid("1900", spec.idx);
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, ${spec.kind}, ${spec.name}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name, topic, is_private, metadata)
      values (${threadId}, ${orgId}, ${spec.name}, ${spec.topic}, ${spec.isPrivate},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, dm: spec.kind === "chat_dm" })})
    `;
    for (const memberId of spec.members) {
      const role = memberId === ADMIN_ACTOR ? "owner" : "member";
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${orgId}, ${memberId}, 'thread', ${threadId}, ${role}, ${ADMIN_ACTOR})
      `;
    }
    let lastMessageId = "";
    for (const [mi, msg] of spec.messages.entries()) {
      const messageId = uid("1a00", spec.idx * 20 + mi);
      lastMessageId = messageId;
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${messageId}, ${orgId}, ${threadId}, ${msg.actor}, 'chat', ${msg.body}, 'plain',
          ${json(sql, { source: WORKSPACE_SEED_SOURCE })},
          ${daysFromNow(-msg.daysAgo, msg.hour, msg.minute)}
        )
      `;
      messageCount += 1;
    }
    // Read receipts for both login actors.
    for (const actorId of [ADMIN_ACTOR, USER_ACTOR]) {
      if (!spec.members.includes(actorId)) {
        continue;
      }
      await sql`
        insert into chat_read_receipts (thread_id, actor_id, org_id, last_read_message_id, last_read_at)
        values (${threadId}, ${actorId}, ${orgId}, ${lastMessageId}, ${daysFromNow(0, 12)})
      `;
    }
  }

  // Reactions on a few messages.
  const reactions = [
    { messageId: uid("1a00", 1 * 20 + 3), actor: ADMIN_ACTOR, emoji: "tada" },
    { messageId: uid("1a00", 1 * 20 + 3), actor: USER_ACTOR, emoji: "raised_hands" },
    { messageId: uid("1a00", 2 * 20 + 3), actor: ADMIN_ACTOR, emoji: "white_check_mark" },
    { messageId: uid("1a00", 3 * 20 + 2), actor: TEAM[2].id, emoji: "bulb" },
    { messageId: uid("1a00", 3 * 20 + 2), actor: USER_ACTOR, emoji: "thumbsup" },
  ];
  for (const r of reactions) {
    await sql`
      insert into chat_reactions (message_id, actor_id, org_id, emoji)
      values (${r.messageId}, ${r.actor}, ${orgId}, ${r.emoji})
    `;
  }
  // Pin one important message in #engineering.
  await sql`
    insert into chat_pins (message_id, thread_id, org_id, pinned_by_actor_id, metadata)
    values (${uid("1a00", 2 * 20 + 4)}, ${uid("1900", 2)}, ${orgId}, ${ADMIN_ACTOR},
      ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
  `;

  return { rooms: specs.length, messages: messageCount };
}

// ===========================================================================
// Sheets — 4 spreadsheets, multiple tabs, realistic cell data.
// ===========================================================================

interface SheetSpec {
  readonly idx: number;
  readonly title: string;
  readonly tabs: readonly {
    readonly name: string;
    readonly rows: readonly (readonly string[])[];
  }[];
}

function sheetSpecs(): readonly SheetSpec[] {
  return [
    {
      idx: 1,
      title: "Roadmap Tracker",
      tabs: [
        {
          name: "Q3",
          rows: [
            ["Initiative", "Owner", "Priority", "Status", "Target"],
            ["Assistant automation", "Sasha Okafor", "P0", "In progress", "Aug 15"],
            ["Sheets formula engine", "Sasha Okafor", "P0", "Beta", "Jul 30"],
            ["Meet recording pipeline", "Riley Chen", "P1", "In progress", "Sep 10"],
            ["Share dialog rewording", "Priya Raman", "P1", "Not started", "Jul 5"],
            ["Keyboard shortcuts", "Priya Raman", "P2", "Not started", "Sep 1"],
          ],
        },
        {
          name: "Q4 Backlog",
          rows: [
            ["Initiative", "Theme", "Estimate"],
            ["Storage tier migration", "Infrastructure", "Large"],
            ["Offline Docs", "Reliability", "Large"],
            ["Advanced audit logging", "Enterprise", "Medium"],
            ["Calendar resource booking", "Productivity", "Medium"],
          ],
        },
      ],
    },
    {
      idx: 2,
      title: "Expense Tracker 2026",
      tabs: [
        {
          name: "May",
          rows: [
            ["Date", "Category", "Description", "Amount", "Submitted by"],
            ["2026-05-03", "Travel", "Taxi to client site", "32.50", "Riley Chen"],
            ["2026-05-08", "Meals", "Team lunch", "184.20", "Priya Raman"],
            ["2026-05-12", "Software", "Design tool seat", "29.00", "Priya Raman"],
            ["2026-05-15", "Travel", "Conference flight", "412.00", "Sasha Okafor"],
            ["2026-05-19", "Office", "Standing desk riser", "78.99", "Riley Chen"],
          ],
        },
        {
          name: "April",
          rows: [
            ["Date", "Category", "Description", "Amount", "Submitted by"],
            ["2026-04-04", "Meals", "Client dinner", "146.75", "Leo Whitfield"],
            ["2026-04-11", "Software", "Monitoring add-on", "59.00", "Sasha Okafor"],
            ["2026-04-22", "Travel", "Train tickets", "88.40", "Morgan Diaz"],
          ],
        },
        {
          name: "Summary",
          rows: [
            ["Month", "Total", "Budget", "Variance"],
            ["April", "294.15", "1500.00", "-1205.85"],
            ["May", "736.69", "1500.00", "-763.31"],
          ],
        },
      ],
    },
    {
      idx: 3,
      title: "Budget Forecast",
      tabs: [
        {
          name: "FY2026",
          rows: [
            ["Line item", "Q1", "Q2", "Q3", "Q4"],
            ["Engineering", "420000", "445000", "470000", "490000"],
            ["Product", "180000", "185000", "195000", "200000"],
            ["Design", "120000", "122000", "128000", "130000"],
            ["Marketing", "95000", "110000", "140000", "160000"],
            ["Infrastructure", "60000", "64000", "72000", "85000"],
          ],
        },
        {
          name: "Headcount",
          rows: [
            ["Team", "Current", "Planned", "Open"],
            ["Engineering", "14", "18", "4"],
            ["Product", "5", "6", "1"],
            ["Design", "4", "5", "1"],
            ["Customer Success", "3", "4", "1"],
          ],
        },
      ],
    },
    {
      idx: 4,
      title: "Survey Results",
      tabs: [
        {
          name: "Responses",
          rows: [
            ["Respondent", "Role", "Satisfaction", "Top request"],
            ["R-001", "Engineer", "8", "Keyboard shortcuts"],
            ["R-002", "Manager", "9", "Better reporting"],
            ["R-003", "Designer", "7", "Offline Docs"],
            ["R-004", "Engineer", "9", "Keyboard shortcuts"],
            ["R-005", "Admin", "6", "Permissions clarity"],
            ["R-006", "Engineer", "8", "Offline Docs"],
          ],
        },
        {
          name: "Themes",
          rows: [
            ["Theme", "Mentions", "Priority"],
            ["Keyboard shortcuts", "18", "High"],
            ["Offline Docs", "11", "Medium"],
            ["Permissions clarity", "9", "High"],
            ["Better reporting", "6", "Low"],
          ],
        },
      ],
    },
  ];
}

async function seedSheets(
  sql: SeedSql,
  orgId: string,
): Promise<{ sheets: number; tabs: number; cells: number }> {
  const specs = sheetSpecs();
  let tabCount = 0;
  let cellCount = 0;
  for (const spec of specs) {
    const sheetId = uid("1b00", spec.idx);
    await sql`
      insert into sheets (id, org_id, owner_actor_id, created_by_actor_id, title, metadata)
      values (${sheetId}, ${orgId}, ${ADMIN_ACTOR}, ${ADMIN_ACTOR}, ${spec.title},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
    `;
    // Shared-PK objects row — makes this sheet visible as a Drive entry.
    const sheetFolderIdx = SHEET_FOLDERS[spec.idx];
    const sheetFolderId = sheetFolderIdx !== undefined ? uid("0f00", sheetFolderIdx) : null;
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${sheetId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`sheets/${orgId}/${sheetId}`},
        'application/vnd.helix.spreadsheet', 0, null,
        ${json(sql, {
          source: WORKSPACE_SEED_SOURCE,
          app: "sheets",
          name: spec.title,
          title: spec.title,
          folderId: sheetFolderId,
        })}
      )
      on conflict (id) do update set
        metadata = excluded.metadata,
        updated_at = now()
    `;
    for (const [ti, tab] of spec.tabs.entries()) {
      const tabId = uid("1c00", spec.idx * 10 + ti);
      await sql`
        insert into sheet_tabs (id, org_id, sheet_id, name, position, metadata)
        values (${tabId}, ${orgId}, ${sheetId}, ${tab.name}, ${ti},
          ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
      `;
      tabCount += 1;
      for (const [rowIdx, row] of tab.rows.entries()) {
        for (const [colIdx, value] of row.entries()) {
          const isHeader = rowIdx === 0;
          await sql`
            insert into sheet_cells (id, org_id, sheet_tab_id, row, col, value, format)
            values (
              ${uid("1d00", (spec.idx * 1000 + ti * 100 + rowIdx * 10 + colIdx) % 99_999_999)},
              ${orgId}, ${tabId}, ${rowIdx}, ${colIdx}, ${value},
              ${json(sql, isHeader ? { bold: true } : {})}
            )
            on conflict (sheet_tab_id, row, col) do update set value = excluded.value, format = excluded.format
          `;
          cellCount += 1;
        }
      }
    }
    await grantBoth(sql, orgId, "sheet", sheetId, "owner");
  }
  return { sheets: specs.length, tabs: tabCount, cells: cellCount };
}

// ===========================================================================
// Slides — 4 decks covering the six layouts.
// ===========================================================================

interface SlideSpec {
  readonly layout: string;
  readonly content: Record<string, unknown>;
  readonly notes: string;
}

interface DeckSpec {
  readonly idx: number;
  readonly title: string;
  readonly slides: readonly SlideSpec[];
}

function deckSpecs(): readonly DeckSpec[] {
  return [
    {
      idx: 1,
      title: "Q3 Roadmap Review",
      slides: [
        {
          layout: "title",
          content: {
            layout: "title",
            title: "Q3 Roadmap Review",
            eyebrow: "Helix Product",
            subtitle: "Locking priorities for the quarter",
          },
          notes: "Welcome the room, set the goal: leave with a locked roadmap.",
        },
        {
          layout: "agenda",
          content: {
            layout: "agenda",
            title: "Agenda",
            items: ["Where we are", "Three candidate bets", "Sequencing & trade-offs", "Decision"],
          },
          notes: "Keep this tight — five minutes max.",
        },
        {
          layout: "stats",
          content: {
            layout: "stats",
            title: "Where we are",
            subtitle: "Heading into Q3",
            stats: [
              { value: "70%", label: "Formula engine parser complete", note: "Ahead of plan" },
              { value: "9 min", label: "80k-message import time", note: "After the fix" },
              { value: "3", label: "Open launch checklist items", note: "Down from 8" },
            ],
          },
          notes: "Lead with momentum before asking for hard prioritization.",
        },
        {
          layout: "bullets",
          content: {
            layout: "bullets",
            title: "Three candidate bets",
            items: [
              "Assistant automation — chained, confirmed actions",
              "Sheets formula engine — arithmetic, references, 20 functions",
              "Meet recording pipeline — capture, store, transcribe",
            ],
          },
          notes: "We can fund roughly two and a half of these.",
        },
        {
          layout: "split",
          content: {
            layout: "split",
            title: "Sequencing",
            left: "The recording pipeline should not block on the storage migration. Ship against current storage; budget explicit Q4 time to migrate.",
            rightKind: "list",
            rightContent: [
              "Recording: Q3, current storage",
              "Migration: Q4, explicit line item",
              "Formula engine: pull earlier",
            ],
          },
          notes: "This is the key decision — make sure everyone agrees before moving on.",
        },
        {
          layout: "image",
          content: {
            layout: "image",
            title: "Proposed Q3 timeline",
            note: "Gantt view — see the Roadmap Tracker sheet for the live version.",
          },
          notes: "Reference the live sheet rather than reading the chart.",
        },
      ],
    },
    {
      idx: 2,
      title: "Helix Enterprise Launch",
      slides: [
        {
          layout: "title",
          content: {
            layout: "title",
            title: "Helix for Enterprise",
            eyebrow: "Launch",
            subtitle: "The connected workspace, with enterprise controls",
            bg: "accent",
          },
          notes: "This is the external launch narrative.",
        },
        {
          layout: "split",
          content: {
            layout: "split",
            title: "What's new",
            left: "Helix for Enterprise adds the governance larger organizations need without changing the product teams already love.",
            rightKind: "list",
            rightContent: [
              "Data residency options",
              "Advanced audit logging",
              "Centralized administration",
            ],
          },
          notes: "Emphasize: same product, more control.",
        },
        {
          layout: "stats",
          content: {
            layout: "stats",
            title: "Why now",
            stats: [
              { value: "40%", label: "YoY usage growth at Northwind", note: "" },
              { value: "8", label: "Connected surfaces", note: "Mail to Meet" },
              { value: "1", label: "Workspace", note: "Everything in one place" },
            ],
          },
          notes: "Northwind is the anchor reference account.",
        },
        {
          layout: "bullets",
          content: {
            layout: "bullets",
            title: "Launch checklist",
            items: [
              "Recording pipeline sign-off",
              "Data residency documentation",
              "Updated pricing page",
            ],
          },
          notes: "Three items left — all must be green before announce.",
        },
      ],
    },
    {
      idx: 3,
      title: "Design Review — Drive Browser",
      slides: [
        {
          layout: "title",
          content: {
            layout: "title",
            title: "Drive Browser Refresh",
            eyebrow: "Design Review",
            subtitle: "Nested folders, clearer files, unified details",
          },
          notes: "Quick intro, then straight into the mockups.",
        },
        {
          layout: "bullets",
          content: {
            layout: "bullets",
            title: "Headline changes",
            items: [
              "Inline folder expansion",
              "Color-coded file type icons",
              "Version history + sharing in one detail panel",
            ],
          },
          notes: "",
        },
        {
          layout: "split",
          content: {
            layout: "split",
            title: "Open question",
            left: "The breadcrumb gets crowded at 3+ levels deep. Proposal: collapse the middle segments into a '…' menu, keep first and last visible.",
            rightKind: "quote",
            rightContent: "What if deep paths collapse the middle segments into a '…' menu?",
            quoteWho: "Riley Chen",
          },
          notes: "Credit Riley — the idea came out of the design channel.",
        },
        {
          layout: "image",
          content: {
            layout: "image",
            title: "Refreshed browser mockup",
            note: "Full mockups are in Drive > Design Docs.",
          },
          notes: "",
        },
      ],
    },
    {
      idx: 4,
      title: "Team Offsite Plan",
      slides: [
        {
          layout: "title",
          content: {
            layout: "title",
            title: "Team Offsite",
            eyebrow: "Helix Team",
            subtitle: "Three days at The Foundry",
          },
          notes: "Set an upbeat tone.",
        },
        {
          layout: "agenda",
          content: {
            layout: "agenda",
            title: "Three days",
            items: [
              "Day 1 — Strategy & planning",
              "Day 2 — Workshops & deep dives",
              "Day 3 — Retro & social",
            ],
          },
          notes: "",
        },
        {
          layout: "bullets",
          content: {
            layout: "bullets",
            title: "Logistics",
            items: [
              "Venue: The Foundry (downtown, walkable)",
              "Travel: arrange your own, expense it",
              "Dietary needs: add to the offsite sheet by Friday",
            ],
          },
          notes: "Walkability was the deciding factor.",
        },
      ],
    },
  ];
}

async function seedSlides(sql: SeedSql, orgId: string): Promise<{ decks: number; slides: number }> {
  const specs = deckSpecs();
  let slideCount = 0;
  for (const spec of specs) {
    const deckId = uid("1e00", spec.idx);
    await sql`
      insert into slide_decks (id, org_id, title, owner_actor_id, created_by_actor_id, metadata)
      values (${deckId}, ${orgId}, ${spec.title}, ${ADMIN_ACTOR}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE })})
    `;
    // Shared-PK objects row — makes this deck visible as a Drive entry.
    const deckFolderIdx = DECK_FOLDERS[spec.idx];
    const deckFolderId = deckFolderIdx !== undefined ? uid("0f00", deckFolderIdx) : null;
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${deckId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`slides/${orgId}/${deckId}`},
        'application/vnd.helix.presentation', 0, null,
        ${json(sql, {
          source: WORKSPACE_SEED_SOURCE,
          app: "slides",
          name: spec.title,
          title: spec.title,
          folderId: deckFolderId,
        })}
      )
      on conflict (id) do update set
        metadata = excluded.metadata,
        updated_at = now()
    `;
    for (const [pi, slide] of spec.slides.entries()) {
      await sql`
        insert into slides (id, org_id, deck_id, position, layout, content, speaker_notes)
        values (
          ${uid("1f00", spec.idx * 20 + pi)}, ${orgId}, ${deckId}, ${pi},
          ${slide.layout}, ${json(sql, slide.content as postgres.JSONValue)}, ${slide.notes}
        )
      `;
      slideCount += 1;
    }
    await grantBoth(sql, orgId, "slide_deck", deckId, "owner");
  }
  return { decks: specs.length, slides: slideCount };
}

// ===========================================================================
// Meet — scheduled upcoming + past meetings, a couple with recordings.
// ===========================================================================

interface MeetSpec {
  readonly idx: number;
  readonly subject: string;
  readonly roomName: string;
  readonly status: "scheduled" | "ended";
  readonly dayOffset: number;
  readonly startHour: number;
  readonly durationMin: number;
  readonly participants: readonly string[];
  readonly recording?: boolean;
  readonly summary?: string;
}

async function seedMeet(
  sql: SeedSql,
  orgId: string,
): Promise<{ rooms: number; recordings: number }> {
  const specs: MeetSpec[] = [
    {
      idx: 1,
      subject: "Q3 Roadmap Review",
      roomName: "helix-q3-roadmap",
      status: "scheduled",
      dayOffset: 1,
      startHour: 13,
      durationMin: 90,
      participants: [TEAM[0].id, TEAM[1].id, TEAM[2].id],
    },
    {
      idx: 2,
      subject: "Design Review — Drive Browser",
      roomName: "helix-drive-design",
      status: "scheduled",
      dayOffset: 3,
      startHour: 11,
      durationMin: 45,
      participants: [TEAM[2].id],
    },
    {
      idx: 3,
      subject: "1:1 with Morgan",
      roomName: "helix-morgan-1on1",
      status: "scheduled",
      dayOffset: 1,
      startHour: 16,
      durationMin: 30,
      participants: [TEAM[0].id],
    },
    {
      idx: 4,
      subject: "Customer Call — Northwind",
      roomName: "helix-northwind-call",
      status: "scheduled",
      dayOffset: 9,
      startHour: 13,
      durationMin: 60,
      participants: [TEAM[3].id, TEAM[4].id],
    },
    {
      idx: 5,
      subject: "Q2 Retrospective",
      roomName: "helix-q2-retro",
      status: "ended",
      dayOffset: -7,
      startHour: 14,
      durationMin: 90,
      participants: [TEAM[0].id, TEAM[1].id, TEAM[2].id],
      recording: true,
      summary:
        "## Q2 Retrospective — Summary\n\n**Went well:** the legacy mail migration shipped on time; cross-team communication improved.\n\n**Needs work:** incident response was slow on the mail delays; staging environment drifted from production.\n\n**Actions:** add a staging parity check to CI; rotate the on-call runbook owner each quarter.",
    },
    {
      idx: 6,
      subject: "Hiring Loop — Backend Engineer",
      roomName: "helix-hiring-backend",
      status: "ended",
      dayOffset: -3,
      startHour: 10,
      durationMin: 240,
      participants: [TEAM[1].id],
      recording: true,
      summary:
        "## Hiring Loop — Backend Engineer\n\nStrong systems-design round; clean sharding strategy without prompting. Coding round solid but slow. Loop consensus: **hire**.",
    },
    {
      idx: 7,
      subject: "Incident Review — Mail Delays",
      roomName: "helix-incident-mail",
      status: "ended",
      dayOffset: -4,
      startHour: 11,
      durationMin: 45,
      participants: [TEAM[1].id],
    },
  ];

  let recordingCount = 0;
  for (const spec of specs) {
    const threadId = uid("2000", spec.idx);
    const roomId = uid("2100", spec.idx);
    const startsAt = daysFromNow(spec.dayOffset, spec.startHour, 0);
    const endsAt = new Date(startsAt.getTime() + spec.durationMin * 60_000);
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'call', ${spec.subject}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_SOURCE, jitsiDomain: "meet.helix.local", roomName: spec.roomName })})
    `;
    await sql`
      insert into meet_rooms (
        id, org_id, thread_id, room_name, subject, jitsi_domain, created_by_actor_id,
        started_at, ended_at, scheduled_start_at, scheduled_end_at, status, metadata
      )
      values (
        ${roomId}, ${orgId}, ${threadId}, ${spec.roomName}, ${spec.subject},
        'meet.helix.local', ${ADMIN_ACTOR}, ${startsAt},
        ${spec.status === "ended" ? endsAt : null},
        ${spec.status === "scheduled" ? startsAt : null},
        ${spec.status === "scheduled" ? endsAt : null},
        ${spec.status}, ${json(sql, { source: WORKSPACE_SEED_SOURCE })}
      )
    `;
    // Grants: both login actors + supporting participants.
    for (const actorId of [ADMIN_ACTOR, USER_ACTOR]) {
      const role = actorId === ADMIN_ACTOR ? "owner" : "member";
      await sql`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id) values (${orgId}, ${actorId}, 'thread', ${threadId}, ${role}, ${ADMIN_ACTOR})`;
      await sql`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id) values (${orgId}, ${actorId}, 'meet_room', ${roomId}, ${role}, ${ADMIN_ACTOR})`;
    }
    for (const participantId of spec.participants) {
      await sql`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id) values (${orgId}, ${participantId}, 'thread', ${threadId}, 'member', ${ADMIN_ACTOR})`;
      await sql`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id) values (${orgId}, ${participantId}, 'meet_room', ${roomId}, 'member', ${ADMIN_ACTOR})`;
    }
    // Summary message.
    if (spec.summary !== undefined) {
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${uid("2200", spec.idx)}, ${orgId}, ${threadId}, ${ADMIN_ACTOR}, 'system',
          ${spec.summary}, 'markdown',
          ${json(sql, { source: WORKSPACE_SEED_SOURCE, type: "meet.summary" })}, ${endsAt}
        )
      `;
    }
    // Recording (object + system message + attachment).
    if (spec.recording === true) {
      const objectId = uid("2300", spec.idx);
      const messageId = uid("2400", spec.idx);
      const recBody = `Recording for "${spec.subject}"`;
      await sql`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, created_at)
        values (
          ${objectId}, ${orgId}, ${ADMIN_ACTOR}, 'recording',
          ${`recordings/${roomId}/recording.mp4`}, 'video/mp4',
          ${Math.round(spec.durationMin * 2.4 * 1024 * 1024)}, ${sha(recBody)},
          ${json(sql, {
            source: WORKSPACE_SEED_SOURCE,
            roomId,
            threadId,
            roomName: spec.roomName,
            startedAt: startsAt.toISOString(),
            endedAt: endsAt.toISOString(),
          })},
          ${endsAt}
        )
      `;
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${messageId}, ${orgId}, ${threadId}, ${ADMIN_ACTOR}, 'system',
          ${recBody}, 'plain',
          ${json(sql, { source: WORKSPACE_SEED_SOURCE, type: "meet.recording", objectId, storageKey: `recordings/${roomId}/recording.mp4` })},
          ${endsAt}
        )
      `;
      await sql`
        insert into message_attachments (message_id, object_id, disposition)
        values (${messageId}, ${objectId}, 'recording')
      `;
      await grantBoth(sql, orgId, "object", objectId, "reader");
      recordingCount += 1;
    }
  }
  return { rooms: specs.length, recordings: recordingCount };
}

// ===========================================================================
// Activity — the notification / activity feed surface.
// ===========================================================================

async function seedActivity(sql: SeedSql, orgId: string): Promise<number> {
  const entries = [
    {
      actor: TEAM[0].id,
      verb: "docs.comment.created",
      objectType: "document",
      objectId: uid("1300", 1),
      summary: 'Morgan Diaz mentioned you in a comment on "Q3 Roadmap & Planning".',
      daysAgo: 1,
    },
    {
      actor: TEAM[1].id,
      verb: "drive.file.shared",
      objectType: "object",
      objectId: uid("1000", 6),
      summary: 'Sasha Okafor shared "Competitor Analysis.helixdoc" with you.',
      daysAgo: 2,
    },
    {
      actor: TEAM[2].id,
      verb: "docs.document.shared",
      objectType: "document",
      objectId: uid("1300", 3),
      summary: 'Priya Raman shared "Helix Brand Guidelines" with you.',
      daysAgo: 3,
    },
    {
      actor: TEAM[3].id,
      verb: "chat.message.mention",
      objectType: "thread",
      objectId: uid("1900", 1),
      summary: "Leo Whitfield mentioned you in #general.",
      daysAgo: 1,
    },
    {
      actor: TEAM[0].id,
      verb: "calendar.event.invited",
      objectType: "event",
      objectId: uid("1800", 2),
      summary: 'Morgan Diaz invited you to "Q3 roadmap review".',
      daysAgo: 2,
    },
    {
      actor: TEAM[1].id,
      verb: "meet.recording.attached",
      objectType: "meet_room",
      objectId: uid("2100", 5),
      summary: 'A recording is ready for "Q2 Retrospective".',
      daysAgo: 7,
    },
    {
      actor: ADMIN_ACTOR,
      verb: "mail.thread.received",
      objectType: "thread",
      objectId: uid("0c00", 3),
      summary: 'New escalation: "Customer escalation — Northwind onboarding".',
      daysAgo: 1,
    },
    {
      actor: TEAM[4].id,
      verb: "sheets.sheet.shared",
      objectType: "sheet",
      objectId: uid("1b00", 2),
      summary: 'Nadia Korhonen shared "Expense Tracker 2026" with you.',
      daysAgo: 1,
    },
    {
      actor: TEAM[2].id,
      verb: "docs.comment.resolved",
      objectType: "document",
      objectId: uid("1300", 2),
      summary: 'Priya Raman resolved a comment on "New Hire Onboarding Checklist".',
      daysAgo: 2,
    },
  ];
  let prevHash: string | null = null;
  for (const [i, e] of entries.entries()) {
    const payload = { source: WORKSPACE_SEED_SOURCE, summary: e.summary };
    const thisHash = sha(`${orgId}:${e.verb}:${e.objectId}:${String(i)}`);
    await sql`
      insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash, created_at)
      values (
        ${orgId}, ${e.actor}, ${e.verb}, ${e.objectType}, ${e.objectId},
        ${json(sql, payload)}, ${prevHash}, ${thisHash}, ${daysFromNow(-e.daysAgo, 10, i)}
      )
      on conflict (this_hash) do nothing
    `;
    prevHash = thisHash;
  }
  return entries.length;
}

// ===========================================================================
// Orchestration.
// ===========================================================================

export async function seedWorkspace(
  sql: postgres.Sql,
  options: SeedWorkspaceOptions = {},
): Promise<SeedWorkspaceResult> {
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const counts: Record<string, number> = {};

  await sql.begin(async (tx) => {
    await clearWorkspace(tx, orgId);
    await seedTeam(tx, orgId);
    counts.teamActors = TEAM.length;

    counts.mailThreads = await seedMail(tx, orgId);

    const drive = await seedDrive(tx, orgId);
    counts.driveFolders = drive.folders;
    counts.driveFiles = drive.files;

    counts.docs = await seedDocs(tx, orgId);

    const cal = await seedCalendar(tx, orgId);
    counts.calendars = cal.calendars;
    counts.calendarEvents = cal.events;

    const chat = await seedChat(tx, orgId);
    counts.chatRooms = chat.rooms;
    counts.chatMessages = chat.messages;

    const sheets = await seedSheets(tx, orgId);
    counts.sheets = sheets.sheets;
    counts.sheetTabs = sheets.tabs;
    counts.sheetCells = sheets.cells;

    const slides = await seedSlides(tx, orgId);
    counts.slideDecks = slides.decks;
    counts.slides = slides.slides;

    const meet = await seedMeet(tx, orgId);
    counts.meetRooms = meet.rooms;
    counts.meetRecordings = meet.recordings;

    counts.activity = await seedActivity(tx, orgId);
  });

  return { orgId, counts };
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const orgId = process.env.HELIX_DEFAULT_ORG_ID ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
    const result = await seedWorkspace(sql, { orgId });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
