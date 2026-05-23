/* seed-scenarios.ts
 *
 * Populates the mail / calendar / chat surfaces with realistic scenarios
 * tied to the principals created by reseed.ts. Everything random-UUID,
 * everything content-authored (no stubs).
 *
 * Layout:
 *   • ~20 mail threads (5–8 multi-message conversations, mix of incoming
 *     + outgoing, varied senders + recipients)
 *   • ~12 calendar events spread across the next 2 weeks (standups,
 *     reviews, demos, 1:1s, all-hands)
 *   • 5 chat rooms (#general, #engineering, #product, #design, #random)
 *     each with 8–15 realistic messages
 *   • Activity feed entries for the past week
 *
 * Idempotent: re-runs purge the seed-tagged rows first (look for
 * `metadata.source = 'scenarios'`) and re-author them. Safe to run as
 * the final step of `reseed.ts`.
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";

type SeedSql = postgres.Sql | postgres.TransactionSql;

interface Actor {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
}

/** Look up actors by email; the reseed has already given them random IDs. */
async function loadActors(sql: SeedSql): Promise<ReadonlyMap<string, Actor>> {
  const rows = (await sql`
    select id, org_id, email, display_name
    from actors
    where email like '%@helix.local'
  `) as unknown as readonly { readonly id: string; readonly org_id: string; readonly email: string; readonly display_name: string }[];
  const map = new Map<string, Actor>();
  for (const r of rows) {
    if (r.email) map.set(r.email, { id: r.id, orgId: r.org_id, email: r.email, displayName: r.display_name });
  }
  return map;
}

/** Time helper — produce a Date n hours offset from now, optionally
 *  rounded to the nearest 5 minutes for natural-looking timestamps. */
function offset(hours: number): Date {
  const t = Date.now() + hours * 60 * 60 * 1000;
  return new Date(Math.round(t / 300_000) * 300_000);
}

// -------------------------------------------------------------------------
// Mail
// -------------------------------------------------------------------------

interface MailMessage {
  readonly fromEmail: string;
  readonly bodyAgoHours: number; // negative = past
  readonly body: string;
}

interface MailThreadSpec {
  readonly subject: string;
  readonly participants: readonly string[]; // emails (one is admin/user)
  readonly category?: "primary" | "social" | "promotions" | "updates" | "forums";
  readonly labels?: readonly string[]; // applied to admin's thread_state
  readonly starred?: boolean;
  readonly read?: boolean;
  readonly messages: readonly MailMessage[];
}

const MAIL_THREADS: readonly MailThreadSpec[] = [
  {
    subject: "Q4 roadmap — finalize priorities by Friday",
    participants: ["morgan@helix.local", "admin@helix.local", "sasha@helix.local", "priya@helix.local"],
    category: "primary",
    starred: true,
    read: false,
    messages: [
      { fromEmail: "morgan@helix.local", bodyAgoHours: -36, body: "Team — pulling together the Q4 priority list for the leadership review on Friday. Please drop your top three asks for the quarter into the planning doc by Wednesday EOD." },
      { fromEmail: "sasha@helix.local", bodyAgoHours: -28, body: "Engineering's three: 1) finish the OnlyOffice integration, 2) ship the new search index, 3) cut the legacy Yjs editor. Doc updated." },
      { fromEmail: "priya@helix.local", bodyAgoHours: -22, body: "From design: refresh the file-row treatment, ship the new empty-state illustrations, finalize the doc preview chrome. Ready to walk through Friday." },
      { fromEmail: "morgan@helix.local", bodyAgoHours: -6, body: "Great — those line up with what I'm hearing from accounts. I'll consolidate and we'll review at 10am Friday." },
    ],
  },
  {
    subject: "Security advisory: rotate Slack webhook secrets",
    participants: ["nadia@helix.local", "admin@helix.local", "sasha@helix.local"],
    category: "primary",
    labels: ["important"],
    read: false,
    messages: [
      { fromEmail: "nadia@helix.local", bodyAgoHours: -8, body: "Slack disclosed a webhook URL-pattern weakness yesterday. Action required: rotate the four outbound webhook secrets we have configured (helix-alerts, helix-deploys, helix-mail-bounce, helix-incident-bot) by Monday noon. Audit log entries linked." },
    ],
  },
  {
    subject: "Re: Welcome to Helix",
    participants: ["admin@helix.local", "user@helix.local"],
    category: "primary",
    starred: true,
    read: true,
    messages: [
      { fromEmail: "admin@helix.local", bodyAgoHours: -120, body: "Hi Riley — welcome aboard! Your laptop is on its way, IT will pair you with a buddy by Wednesday. Loop me on anything blocking you." },
      { fromEmail: "user@helix.local", bodyAgoHours: -100, body: "Thanks Avery! Excited to be here. I'll keep notes as I onboard so we can sharpen the new-hire docs." },
    ],
  },
  {
    subject: "Design review feedback — file preview",
    participants: ["priya@helix.local", "admin@helix.local", "leo@helix.local"],
    category: "primary",
    messages: [
      { fromEmail: "priya@helix.local", bodyAgoHours: -50, body: "Pushed v3 of the preview chrome. Two open questions: (1) do we want a sticky filename header for long PDFs? (2) where should the comment thread anchor live for spreadsheets?" },
      { fromEmail: "leo@helix.local", bodyAgoHours: -44, body: "Yes to sticky header — long PDFs are 80%+ of our preview opens. For sheets, anchoring at the cell range makes more sense than a per-tab counter." },
      { fromEmail: "admin@helix.local", bodyAgoHours: -40, body: "Agreed. Let's mark both as approved and ship in next week's release." },
    ],
  },
  {
    subject: "Vendor renewal: Postgres consulting (FY26)",
    participants: ["erica@helix.local", "admin@helix.local"],
    category: "primary",
    read: false,
    messages: [
      { fromEmail: "erica@helix.local", bodyAgoHours: -16, body: "FY26 renewal proposal attached. They're holding the FY25 rate ($14k/mo) if we sign by 11/30. Worth keeping; query review and the index migration project both came in under budget last year." },
    ],
  },
  {
    subject: "Engineering on-call rotation — next 2 weeks",
    participants: ["sasha@helix.local", "leo@helix.local", "morgan@helix.local", "admin@helix.local"],
    category: "updates",
    read: true,
    messages: [
      { fromEmail: "sasha@helix.local", bodyAgoHours: -55, body: "On-call for the next two weeks:\n  Week 1: Leo primary, me secondary\n  Week 2: Me primary, Priya shadowing\nPaging via PagerDuty. Reply if you can't cover." },
      { fromEmail: "leo@helix.local", bodyAgoHours: -52, body: "Confirmed for week 1." },
    ],
  },
  {
    subject: "New benefits portal goes live Monday",
    participants: ["nadia@helix.local", "admin@helix.local", "user@helix.local", "morgan@helix.local"],
    category: "updates",
    messages: [
      { fromEmail: "nadia@helix.local", bodyAgoHours: -72, body: "HR is migrating to the new benefits portal Monday morning. Single-sign-on link will be in your inbox by 9am ET. The old URL will redirect for 30 days." },
    ],
  },
  {
    subject: "Customer demo prep — Acme account",
    participants: ["user@helix.local", "morgan@helix.local", "priya@helix.local"],
    category: "primary",
    messages: [
      { fromEmail: "user@helix.local", bodyAgoHours: -30, body: "Acme demo is Thursday at 11am. Goal: show off real-time co-edit on the new OnlyOffice integration. I'll send a rehearsal script tomorrow." },
      { fromEmail: "morgan@helix.local", bodyAgoHours: -25, body: "Lean into the comment threading — they've been asking for that across three calls now." },
      { fromEmail: "priya@helix.local", bodyAgoHours: -23, body: "I'll have the demo dataset cleaned up by EOD Wednesday." },
    ],
  },
  {
    subject: "Office closed Friday Nov 28 (Thanksgiving)",
    participants: ["nadia@helix.local", "admin@helix.local", "user@helix.local", "morgan@helix.local"],
    category: "updates",
    read: true,
    messages: [
      { fromEmail: "nadia@helix.local", bodyAgoHours: -200, body: "Reminder: US office closed Friday Nov 28. Slack channels stay open; on-call rotation continues as usual." },
    ],
  },
  {
    subject: "Re: search index — what should we cut?",
    participants: ["leo@helix.local", "sasha@helix.local", "admin@helix.local"],
    category: "primary",
    starred: true,
    messages: [
      { fromEmail: "leo@helix.local", bodyAgoHours: -14, body: "The new search index is 4× faster on cold reads but indexing latency jumped. We need to decide: drop the rich metadata fields or drop the legacy fuzzy-match pass?" },
      { fromEmail: "sasha@helix.local", bodyAgoHours: -10, body: "Drop the fuzzy-match pass. It's hitting <2% of queries and we have telemetry to back-fill it later if usage spikes." },
      { fromEmail: "admin@helix.local", bodyAgoHours: -4, body: "+1. Ship the cut this sprint." },
    ],
  },
  {
    subject: "Welcome to the Helix Product newsletter",
    participants: ["morgan@helix.local", "admin@helix.local"],
    category: "promotions",
    read: true,
    messages: [
      { fromEmail: "morgan@helix.local", bodyAgoHours: -310, body: "Monthly product update — last sprint we shipped: improved Drive previews, real-time co-edit (beta), and the new mail filter rules. Next sprint: dark-mode polish, calendar grouping, and the API rate-limit dashboard." },
    ],
  },
  {
    subject: "Coffee chat?",
    participants: ["maya@helix.local", "admin@helix.local"],
    category: "primary",
    messages: [
      { fromEmail: "maya@helix.local", bodyAgoHours: -2, body: "Hey Avery — would love 20 minutes to swap notes on the LLM-evaluation work we've been doing. Any time Wednesday or Thursday afternoon?" },
    ],
  },
  {
    subject: "Q3 finance close — sign-offs needed",
    participants: ["erica@helix.local", "admin@helix.local"],
    category: "primary",
    starred: true,
    labels: ["important"],
    read: false,
    messages: [
      { fromEmail: "erica@helix.local", bodyAgoHours: -3, body: "Q3 close is on track. I need your sign-off on the engineering capex true-up by Friday. Numbers attached — overall +$28k vs. plan, driven by the database consulting overage we discussed." },
    ],
  },
  {
    subject: "Outage post-mortem — Nov 11",
    participants: ["sasha@helix.local", "leo@helix.local", "morgan@helix.local", "admin@helix.local", "nadia@helix.local"],
    category: "primary",
    messages: [
      { fromEmail: "sasha@helix.local", bodyAgoHours: -90, body: "Post-mortem doc for the 22-minute API outage on Nov 11. Root cause: a connection-pool exhaustion under the new search indexer load. Action items: (1) double pool size, (2) add early-saturation alerts, (3) test plan for indexer back-pressure. Doc link in the next message." },
      { fromEmail: "leo@helix.local", bodyAgoHours: -86, body: "Action items 1 and 2 are merged. Working on 3 this week." },
      { fromEmail: "nadia@helix.local", bodyAgoHours: -80, body: "Looped in audit — they want the post-mortem doc on file by month-end. No changes needed from your side." },
    ],
  },
  {
    subject: "Customer NPS — Q3 results",
    participants: ["morgan@helix.local", "admin@helix.local", "erica@helix.local"],
    category: "primary",
    read: true,
    messages: [
      { fromEmail: "morgan@helix.local", bodyAgoHours: -260, body: "Q3 NPS landed at 47, up from 41. Biggest movers: file collaboration (driven by real-time co-edit beta) and search accuracy. Biggest gap: mobile experience. Full breakdown in attached deck." },
    ],
  },
];

async function seedMail(sql: SeedSql, actorsByEmail: ReadonlyMap<string, Actor>): Promise<{ threads: number; messages: number }> {
  let threads = 0;
  let messages = 0;
  for (const spec of MAIL_THREADS) {
    // First message's sender is the thread "creator". Other messages
    // come from later participants.
    const firstMsg = spec.messages[0];
    if (!firstMsg) continue;
    const creator = actorsByEmail.get(firstMsg.fromEmail);
    if (!creator) continue;
    const threadId = randomUUID();
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${creator.orgId}, 'mail', ${spec.subject}, ${creator.id},
              ${sql.json({ source: "scenarios", participants: spec.participants })})
    `;
    threads += 1;

    for (const msg of spec.messages) {
      const sender = actorsByEmail.get(msg.fromEmail);
      if (!sender) continue;
      const sentAt = offset(msg.bodyAgoHours);
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, sent_at, metadata)
        values (
          ${randomUUID()}, ${creator.orgId}, ${threadId}, ${sender.id},
          'mail', ${msg.body}, 'plain', ${sentAt.toISOString()},
          ${sql.json({
            source: "scenarios",
            from: { address: sender.email, name: sender.displayName },
            to: spec.participants
              .filter((p) => p !== sender.email)
              .map((email) => ({ address: email, name: actorsByEmail.get(email)?.displayName ?? email })),
          })}
        )
      `;
      messages += 1;
    }

    // Mail thread state per participant — gives every participant an
    // inbox row for this thread. Admin gets the spec'd labels/star/read.
    for (const email of spec.participants) {
      const actor = actorsByEmail.get(email);
      if (!actor) continue;
      const isAdminMatch = email === "admin@helix.local";
      const labels = isAdminMatch ? ["inbox", ...(spec.labels ?? [])] : ["inbox"];
      const starred = isAdminMatch && (spec.starred ?? false);
      const readAt = isAdminMatch && spec.read ? new Date(Date.now() - 1000).toISOString() : null;
      await sql`
        insert into mail_thread_state (actor_id, thread_id, org_id, labels, starred, read_at, category)
        values (
          ${actor.id}, ${threadId}, ${actor.orgId},
          ${sql.array(labels, 1009)},
          ${starred}, ${readAt},
          ${spec.category ?? "primary"}::mail_category_tab
        )
      `;
      // Grant the thread to the participant so mail.threads.list can
      // see it via the permissions check.
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${actor.orgId}, ${actor.id}, 'thread', ${threadId}, 'member', ${creator.id})
        on conflict do nothing
      `;
    }
  }
  return { threads, messages };
}

// -------------------------------------------------------------------------
// Calendar
// -------------------------------------------------------------------------

interface CalendarEventSpec {
  readonly title: string;
  readonly organizer: string;
  readonly attendees: readonly string[];
  readonly startsAgoHours: number; // negative = past, positive = future
  readonly durationMinutes: number;
  readonly location?: string;
  readonly description?: string;
}

const CALENDAR_EVENTS: readonly CalendarEventSpec[] = [
  // Recurring-shape standups + 1:1s + reviews spread across the next 2 weeks
  { title: "Engineering standup",     organizer: "sasha@helix.local",  attendees: ["sasha@helix.local","leo@helix.local","priya@helix.local","admin@helix.local"], startsAgoHours: 18,  durationMinutes: 30, location: "Zoom",                  description: "Daily eng sync. Updates, blockers, on-call hand-off." },
  { title: "Q4 roadmap review",       organizer: "morgan@helix.local", attendees: ["morgan@helix.local","admin@helix.local","sasha@helix.local","priya@helix.local","erica@helix.local"], startsAgoHours: 42,  durationMinutes: 90, location: "Conf Room A / Zoom",     description: "Leadership review of Q4 priorities — see roadmap doc." },
  { title: "1:1 Avery / Morgan",      organizer: "admin@helix.local",  attendees: ["admin@helix.local","morgan@helix.local"], startsAgoHours: 26, durationMinutes: 30 },
  { title: "Design review — preview chrome", organizer: "priya@helix.local",  attendees: ["priya@helix.local","admin@helix.local","leo@helix.local","morgan@helix.local"], startsAgoHours: 52,  durationMinutes: 45, location: "Zoom", description: "v3 preview chrome walkthrough; comment-anchor proposal." },
  { title: "Customer demo — Acme",    organizer: "user@helix.local",   attendees: ["user@helix.local","morgan@helix.local","priya@helix.local"], startsAgoHours: 72,  durationMinutes: 45, location: "Zoom", description: "Live demo of the OnlyOffice integration and real-time co-edit." },
  { title: "All-hands",               organizer: "morgan@helix.local", attendees: ["morgan@helix.local","admin@helix.local","user@helix.local","sasha@helix.local","priya@helix.local","leo@helix.local","nadia@helix.local","maya@helix.local","erica@helix.local"], startsAgoHours: 168, durationMinutes: 60, location: "Town Hall / Zoom", description: "Monthly all-hands. Roadmap update, Q3 NPS results, security advisory." },
  { title: "Engineering retro",       organizer: "sasha@helix.local",  attendees: ["sasha@helix.local","leo@helix.local","priya@helix.local","admin@helix.local"], startsAgoHours: 200, durationMinutes: 60, location: "Conf Room B", description: "Sprint retro. What went well, what didn't, what to try." },
  { title: "Security review — webhook rotation", organizer: "nadia@helix.local", attendees: ["nadia@helix.local","sasha@helix.local","admin@helix.local"], startsAgoHours: 96,  durationMinutes: 30, description: "Rotate Slack webhook secrets per the security advisory." },
  { title: "Coffee chat — Maya / Avery", organizer: "maya@helix.local", attendees: ["maya@helix.local","admin@helix.local"], startsAgoHours: 60, durationMinutes: 20, location: "Café" },
  { title: "Finance close — Q3 sign-off", organizer: "erica@helix.local", attendees: ["erica@helix.local","admin@helix.local"], startsAgoHours: 78, durationMinutes: 60, description: "Q3 close review. Sign-offs and overrun discussion." },
  // A couple in the past so the calendar isn't empty for "this week"
  { title: "Outage post-mortem — Nov 11", organizer: "sasha@helix.local", attendees: ["sasha@helix.local","leo@helix.local","morgan@helix.local","admin@helix.local","nadia@helix.local"], startsAgoHours: -84, durationMinutes: 60, location: "Zoom" },
  { title: "Engineering standup",     organizer: "sasha@helix.local",  attendees: ["sasha@helix.local","leo@helix.local","priya@helix.local","admin@helix.local"], startsAgoHours: -6, durationMinutes: 30, location: "Zoom" },
];

async function seedCalendar(sql: SeedSql, actorsByEmail: ReadonlyMap<string, Actor>): Promise<{ calendars: number; events: number }> {
  // One calendar per principal — "Work" calendar.
  let calendars = 0;
  const calByActor = new Map<string, string>();
  for (const actor of actorsByEmail.values()) {
    const calId = randomUUID();
    await sql`
      insert into cal_calendars (id, org_id, owner_actor_id, name, color, timezone, metadata)
      values (${calId}, ${actor.orgId}, ${actor.id}, 'Work', '#1a73e8', 'America/New_York',
              ${sql.json({ source: "scenarios", primary: true })})
    `;
    await sql`
      insert into cal_calendar_memberships (id, org_id, calendar_id, actor_id, role, visible, sort_order)
      values (${randomUUID()}, ${actor.orgId}, ${calId}, ${actor.id}, 'owner', true, 100)
    `;
    calByActor.set(actor.id, calId);
    calendars += 1;
  }

  let events = 0;
  for (const spec of CALENDAR_EVENTS) {
    const organizer = actorsByEmail.get(spec.organizer);
    if (!organizer) continue;
    const calendarId = calByActor.get(organizer.id);
    if (!calendarId) continue;
    const startsAt = offset(spec.startsAgoHours);
    const endsAt = new Date(startsAt.getTime() + spec.durationMinutes * 60_000);
    const eventId = randomUUID();
    await sql`
      insert into cal_events (
        id, org_id, calendar_id, uid, title, description, location,
        starts_at, ends_at, timezone, all_day, status,
        organizer_actor_id, organizer_email, metadata
      ) values (
        ${eventId}, ${organizer.orgId}, ${calendarId},
        ${`scenarios-${eventId}`},
        ${spec.title}, ${spec.description ?? null}, ${spec.location ?? null},
        ${startsAt.toISOString()}, ${endsAt.toISOString()},
        'America/New_York', false, 'confirmed',
        ${organizer.id}, ${organizer.email},
        ${sql.json({ source: "scenarios" })}
      )
    `;
    for (const email of spec.attendees) {
      const attendee = actorsByEmail.get(email);
      if (!attendee) continue;
      await sql`
        insert into cal_attendees (id, org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer)
        values (
          ${randomUUID()}, ${organizer.orgId}, ${eventId}, ${attendee.id}, ${attendee.email}, ${attendee.displayName},
          'required', ${attendee.id === organizer.id ? "accepted" : "needs_action"}, ${attendee.id === organizer.id}
        )
      `;
      // Subscribe each attendee to the organizer's calendar (reader) so
      // they can see the event on /calendar.
      await sql`
        insert into cal_calendar_memberships (id, org_id, calendar_id, actor_id, role, visible, sort_order)
        values (${randomUUID()}, ${organizer.orgId}, ${calendarId}, ${attendee.id}, 'reader', true, 100)
        on conflict do nothing
      `;
    }
    events += 1;
  }
  return { calendars, events };
}

// -------------------------------------------------------------------------
// Chat
// -------------------------------------------------------------------------

interface ChatMessage {
  readonly fromEmail: string;
  readonly ago: number; // hours back
  readonly body: string;
}

interface ChatRoomSpec {
  readonly name: string;
  readonly topic: string;
  readonly members: readonly string[];
  readonly isPrivate?: boolean;
  readonly messages: readonly ChatMessage[];
}

const CHAT_ROOMS: readonly ChatRoomSpec[] = [
  {
    name: "general",
    topic: "Company-wide chatter",
    members: ["admin@helix.local","user@helix.local","morgan@helix.local","sasha@helix.local","priya@helix.local","leo@helix.local","nadia@helix.local","maya@helix.local","erica@helix.local"],
    messages: [
      { fromEmail: "morgan@helix.local", ago: 80, body: "Welcome to the new Helix workspace 🎉 Drop in #engineering or #product for team-specific channels." },
      { fromEmail: "user@helix.local",   ago: 78, body: "Excited to be here! Where do new-hire resources live?" },
      { fromEmail: "admin@helix.local",  ago: 76, body: "Pinned the onboarding doc in this channel. Ping me if anything's missing." },
      { fromEmail: "nadia@helix.local",  ago: 50, body: "Security advisory just went out via email — please rotate webhook secrets this week." },
      { fromEmail: "erica@helix.local",  ago: 36, body: "Quarterly all-hands deck is in /slides for anyone who wants to review ahead of Thursday." },
      { fromEmail: "maya@helix.local",   ago: 14, body: "Heads up: the LLM eval dataset got a fresh batch of human annotations — open in Sheets." },
      { fromEmail: "user@helix.local",   ago: 4, body: "@channel — Acme demo prep walk-through tomorrow at 3pm, 20 min, optional." },
    ],
  },
  {
    name: "engineering",
    topic: "Eng-only discussion, on-call hand-offs",
    members: ["sasha@helix.local","leo@helix.local","priya@helix.local","admin@helix.local","morgan@helix.local"],
    messages: [
      { fromEmail: "sasha@helix.local", ago: 90, body: "On-call hand-off: I'm off the rotation Friday EOD, Leo picks up. Anything pending will be in the runbook." },
      { fromEmail: "leo@helix.local",   ago: 88, body: "Got it. The flaky migration test should be deflaked by EOD today, will note in the runbook." },
      { fromEmail: "priya@helix.local", ago: 60, body: "Anyone seen weird OnlyOffice JWT errors locally? Found it — was an old maxParamLength setting in fastify." },
      { fromEmail: "leo@helix.local",   ago: 58, body: "Yeah saw that yesterday. Bumped to 2048. Should be fixed on main." },
      { fromEmail: "sasha@helix.local", ago: 30, body: "PR review queue is getting long — please prioritize the search-index cut + the new permission projection." },
      { fromEmail: "admin@helix.local", ago: 12, body: "Reviewed both. Search-index ✅, permission projection has one comment thread I left." },
      { fromEmail: "priya@helix.local", ago: 2, body: "Pushed the comment-anchor fix from this morning's design review. RFR." },
    ],
  },
  {
    name: "product",
    topic: "Roadmap, launches, customer feedback",
    members: ["morgan@helix.local","admin@helix.local","user@helix.local","priya@helix.local"],
    messages: [
      { fromEmail: "morgan@helix.local", ago: 100, body: "Q4 priority doc is live: roadmap-q4.docx. Pls comment by Friday." },
      { fromEmail: "user@helix.local",   ago: 96,  body: "Acme came back asking for spreadsheet-comment anchoring — that's #3 in the Q4 doc, so we're aligned." },
      { fromEmail: "priya@helix.local",  ago: 70,  body: "Empty-state illustrations are in figma, will land in the design system this week." },
      { fromEmail: "morgan@helix.local", ago: 22,  body: "Just reviewed Q3 NPS — 47, up from 41. Real-time co-edit is the headline driver." },
      { fromEmail: "user@helix.local",   ago: 8,   body: "I'll pull that into the Acme demo narrative." },
    ],
  },
  {
    name: "design",
    topic: "Design crits, UI specs",
    members: ["priya@helix.local","admin@helix.local","morgan@helix.local"],
    messages: [
      { fromEmail: "priya@helix.local", ago: 120, body: "Doc preview v3 is up. Two TBDs noted: sticky filename, sheet comment anchor." },
      { fromEmail: "admin@helix.local", ago: 116, body: "Loop me when v4 is up — both TBDs are blocking the release." },
      { fromEmail: "priya@helix.local", ago: 50,  body: "v4 done, sent for review via mail thread." },
      { fromEmail: "morgan@helix.local", ago: 46, body: "Approved with one note — let's tighten the corner radius on the chip." },
      { fromEmail: "priya@helix.local", ago: 1, body: "Done. Shipping today." },
    ],
  },
  {
    name: "random",
    topic: "Off-topic, links, memes",
    members: ["admin@helix.local","user@helix.local","morgan@helix.local","sasha@helix.local","priya@helix.local","leo@helix.local","maya@helix.local"],
    messages: [
      { fromEmail: "leo@helix.local",  ago: 200, body: "Anyone else find this paper interesting? https://arxiv.org/abs/2311.xxxxx — applies retrieval to long-context eval in a way I hadn't seen." },
      { fromEmail: "maya@helix.local", ago: 180, body: "Skimmed it, looks promising. Going to try the eval setup on our own corpus this week." },
      { fromEmail: "priya@helix.local", ago: 70, body: "Coffee at Café Andante if anyone wants to join, 3pm." },
      { fromEmail: "user@helix.local", ago: 60,  body: "In!" },
      { fromEmail: "morgan@helix.local", ago: 30, body: "Found a great new sticker for the Slack channel collection 🦊" },
    ],
  },
];

async function seedChat(sql: SeedSql, actorsByEmail: ReadonlyMap<string, Actor>): Promise<{ rooms: number; messages: number }> {
  let rooms = 0;
  let messages = 0;
  for (const spec of CHAT_ROOMS) {
    const creatorEmail = spec.members[0];
    if (!creatorEmail) continue;
    const creator = actorsByEmail.get(creatorEmail);
    if (!creator) continue;
    const threadId = randomUUID();
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${creator.orgId}, 'chat_room', ${`#${spec.name}`}, ${creator.id},
              ${sql.json({ source: "scenarios", channel: spec.name })})
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name, topic, is_private, metadata)
      values (${threadId}, ${creator.orgId}, ${spec.name}, ${spec.topic}, ${spec.isPrivate ?? false},
              ${sql.json({ source: "scenarios" })})
    `;
    rooms += 1;

    // Members get a thread permission grant so chat.list returns them.
    for (const email of spec.members) {
      const member = actorsByEmail.get(email);
      if (!member) continue;
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${member.orgId}, ${member.id}, 'thread', ${threadId},
                ${member.id === creator.id ? "owner" : "member"}, ${creator.id})
        on conflict do nothing
      `;
    }

    for (const msg of spec.messages) {
      const sender = actorsByEmail.get(msg.fromEmail);
      if (!sender) continue;
      const sentAt = offset(-msg.ago);
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, sent_at, metadata)
        values (
          ${randomUUID()}, ${creator.orgId}, ${threadId}, ${sender.id},
          'chat', ${msg.body}, 'plain', ${sentAt.toISOString()},
          ${sql.json({ source: "scenarios" })}
        )
      `;
      messages += 1;
    }
  }
  return { rooms, messages };
}

// -------------------------------------------------------------------------
// Driver
// -------------------------------------------------------------------------

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const actors = await loadActors(sql);
    if (actors.size === 0) {
      process.stderr.write("seed-scenarios: no actors found — run pnpm db:reseed first.\n");
      process.exit(1);
    }
    process.stdout.write(`Hydrating scenarios for ${String(actors.size)} principals…\n`);

    const mailStats = await seedMail(sql, actors);
    process.stdout.write(`  mail:     ${String(mailStats.threads)} threads, ${String(mailStats.messages)} messages\n`);

    const calStats = await seedCalendar(sql, actors);
    process.stdout.write(`  calendar: ${String(calStats.calendars)} calendars, ${String(calStats.events)} events\n`);

    const chatStats = await seedChat(sql, actors);
    process.stdout.write(`  chat:     ${String(chatStats.rooms)} rooms, ${String(chatStats.messages)} messages\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`seed-scenarios FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { main as seedScenarios };
