/**
 * Seed ~30 chat rooms (20 spaces + 10 DMs) with ~5000 messages total.
 *
 * Threads:          f700 group
 * Messages:         f800 group (threadIdx * 200 + messageOffset)
 */

import {
  ADMIN_ACTOR,
  USER_ACTOR,
  WORKSPACE_SEED_LARGE_SOURCE,
  daysFromNow,
  json,
  teamId,
  uid,
  type SeedSql,
} from "./config.js";

// ---------------------------------------------------------------------------
// Name & message pools
// ---------------------------------------------------------------------------

const ACTORS = [
  ADMIN_ACTOR,
  USER_ACTOR,
  ...Array.from({ length: 23 }, (_, i) => teamId(i + 1)),
];


function actorAt(idx: number): string {
  return ACTORS[idx % ACTORS.length] ?? ADMIN_ACTOR;
}

// Message pools — each array is a set of thematically related messages
const GENERAL_MSGS = [
  "Morning everyone! Hope you all had a good weekend.",
  "Quick reminder: sprint planning is Monday at 10am.",
  "Shoutout to Ben for the fast turnaround on the recording pipeline!",
  "Anyone have bandwidth to review PR #490?",
  "The all-hands deck is in Drive. Please review before Thursday.",
  "Lunch at the noodle place today — who's in?",
  "Offsite planning thread is in #offsite-2026. Agenda is coming together!",
  "Reminder: expense reports due Friday. Tracker is in Drive.",
  "The formula engine demo went great. Customers loved it.",
  "Happy Friday! Great week, everyone.",
  "New design tokens are live in the design system — update when you can.",
  "Congrats to Jordan for passing the backend interview loop!",
  "The blog post on the formula engine is published. Give it some shares!",
  "Company birthday event on June 28. Mark your calendars.",
  "Welcome to Preet, joining the backend team next Monday!",
  "SOC 2 gap assessment is done. 38/48 controls passing — good progress.",
  "Production deploy went smoothly. v2.7 is live.",
  "Rate limiting doc is in Drive. Feedback welcome.",
  "The data warehouse is fully migrated to Snowflake. Rosa sends her thanks.",
  "Q3 OKR tracker is updated. Go check if your OKRs are marked correctly.",
  "Thanks everyone for the great Q2 retrospective session today.",
  "New hire orientation deck is in Drive for those who want to update it.",
  "Accessibility audit results are in. 94/100 in Drive > Design.",
  "Bundle size is down 18% after the tree-shaking work. Nice work Celia.",
  "The Northwind call went great. Renewal is looking strong.",
];

const ENGINEERING_MSGS = [
  "PR #488 is up — adds the recording cloud upload. Please review.",
  "WebSocket pooling design doc is in Drive. Architecture review Tuesday.",
  "Heads up: deploying a small hotfix for the search index issue at 2pm UTC.",
  "Formula engine tests are all green. Ready for code review.",
  "Found a race condition in the calendar sync — logged as HEL-492.",
  "The Postgres query plan review found 2 table scans in the drive path. Fixing now.",
  "Staging is back up after the Redis restart. Thanks Ivan.",
  "Mobile tests are flaky on Android emulator. Investigating.",
  "Load test results for WebSocket pooling: 4,200 concurrent connections, stable.",
  "The infra cost analysis is in Drive > Infra. Storage tier adds $3.5k/mo.",
  "Deploying recording pipeline to staging at 4pm. Will ping here when it's live.",
  "The SOC 2 access review evidence is done. 14 systems documented.",
  "Reminder: query plan review is part of the deploy checklist now.",
  "Migration 2026-05 landed cleanly. No issues.",
  "Bundle analysis report is in Drive > Frontend. Worth a read.",
  "New feature flag: `assistant_chaining` is enabled for 5 orgs in staging.",
  "Found an edge case in MIME parsing — malformed Content-Disposition drops attachments. PR coming.",
  "Search FTS index is back to 1.1GB after the cleanup. Was 3.8GB with dead tuples.",
  "Outbox worker is now processing mail and search in separate queues. No more contention.",
  "CI is back. The Postgres container was out of disk in the runner.",
  "Bump: Node.js 22 upgrade is blocked on one dep. Will PR a patch.",
  "Rate limiting is live in staging. Testing with Ivan.",
  "API spec v2 draft is in Drive. Feedback appreciated.",
  "The recording transcription model is at 91% accuracy on the test set.",
  "k8s migration spike is done. Report in Drive > Infra.",
];

const PRODUCT_MSGS = [
  "Drive browser mockups are in Figma. Design review Wednesday.",
  "The sharing dialog rewording mockups are ready. Feedback welcome!",
  "User research readout is in Drive > Research. Key finding: audit logs are blocking enterprise deals.",
  "Q3 OKRs are locked. Summary in Drive > Roadmap.",
  "Beta community feedback on assistant chaining is very positive.",
  "NPS for Sheets formula users is 8.1 — up from 6.4 before GA.",
  "Activation is at 41% multi-surface. Best we've ever seen.",
  "The 'mail to calendar' flow is the #1 activation trigger. We should feature it in onboarding.",
  "Content calendar for June is in Drive. Reviews due by May 28.",
  "The customer journey map is updated with the enterprise pilot findings.",
  "Feature flag review: `meet_recording` can go to internal teams next week.",
  "The pricing doc is in Drive > Product. Feedback from Evan and Lena by EOW.",
  "Persona workshop outputs are in Drive > UX Research.",
  "OKR score for assistant activation is 0.6/1.0. On track for Aug 15.",
  "The competitive analysis Q2 edition is in Drive. Landscape section is updated.",
  "Monthly metrics report for April is live. Rosa has context if you have questions.",
  "Onboarding flow v2 spec is in Docs. Review and comment by Wednesday.",
  "The content brief for the enterprise launch blog series is in Drive.",
  "Beta feedback session with Northwind is scheduled for June 14.",
  "The product principles doc is in Drive. Read it when you get a chance.",
];

const DESIGN_MSGS = [
  "New mockups for the Drive browser redesign are in Figma. Please review before Wednesday's crit.",
  "Icon guidelines doc is updated in Drive > Brand. Using Phosphor icons as base.",
  "Color token changes are in the design system PR. Dark mode tokens look great.",
  "Motion design guidelines are published. 100ms, 200ms, 300ms scale.",
  "Accessibility audit is 94/100. Three items to fix before enterprise GA.",
  "The share dialog rewording is ready for dev handoff. Details in Figma.",
  "Persona workshop photos are in Drive > UX Research.",
  "Brand update: new logo variations in Drive > Brand.",
  "Component screenshots for v2 are in Drive > Design.",
  "The UX research plan for Q3 is published in Docs.",
  "Storybook export is in Drive > Frontend for reference.",
  "Animation prototype for the inline folder expansion is ready. Check it out!",
  "Dark mode is looking solid. Sam did a great pass on the dashboard surfaces.",
  "Figma tokens plugin is set up. Auto-sync to the design system is live.",
  "Design system migration doc is in Drive. Deadline for token references: Jun 15.",
];

const INFRA_MSGS = [
  "Grafana dashboard for the new storage tier is live. Check it out.",
  "PagerDuty rotation is updated. Will confirmed coverage for all of June.",
  "Backup verification for May is complete. All snapshots healthy.",
  "CloudWatch alarm thresholds are updated. Will now page at 80% CPU.",
  "Redis cluster migration is done. No impact on latency observed.",
  "Postgres read replica is provisioned in us-east-1a. Failover test scheduled.",
  "Terraform modules are updated for the enterprise storage buckets.",
  "Certificate rotation is now automated. No more manual renewals.",
  "Storage cost is up 8%/mo. Mostly from Meet recordings in staging.",
  "k8s cluster config is updated. Node size change takes effect at next rollout.",
  "Kinesis pipeline is processing 8k events/sec in staging without drops.",
  "Network topology diagram is updated in Drive > Infra.",
  "The incident runbook v2 is in Drive. Key addition: L2 and L3 escalation paths.",
  "Datadog monitors for WebSocket connections are set up. Alert at 400 connections.",
  "The SOC 2 evidence export is in Drive > Security. Lena is reviewing.",
];

const HIRING_MSGS = [
  "Preet Arora accepted the backend offer. Starting June 2.",
  "Debrief for the frontend loop: Sophie advances to offer. Great candidate.",
  "New job posts are live on LinkedIn and Greenhouse.",
  "Hiring metrics for Q2 are in the tracker sheet. 9 hires, 75% acceptance rate.",
  "Interview rubrics for the SRE role are in Drive > Hiring.",
  "Dev Sharma's phone screen went well. Advancing to technical round.",
  "Ana Becker countered the frontend offer. Circling back with a revised number.",
  "Reminder: all interview scorecards must be in Lever within 24 hours.",
  "New sourcing campaigns are running on LinkedIn for backend and SRE.",
  "Mia Larsson passed the UX researcher screen. Design exercise sent.",
];

const FINANCE_MSGS = [
  "May expense reports are due Friday. Submit via the tracker sheet.",
  "Q2 actuals are in the budget forecast sheet. Within budget.",
  "CloudSupplier invoice for May: $14,800. Approved.",
  "Outside counsel for the DPA review: $1,800. Approved.",
  "The equity refresh analysis is in Drive > Finance > Payroll.",
  "Payroll for May 31 processes on Thursday. Alert HR for any changes.",
  "Budget review meeting is June 5 at 2pm. Agenda in the calendar invite.",
  "DevConf early-bird tickets ($1,200 for 4 seats) are approved.",
  "FY2026 H2 forecast has been updated. Slides for board presentation in Drive.",
  "Vendor renewal tracker is updated. UserTesting review due in 2 weeks.",
];

const CUSTOMER_MSGS = [
  "Northwind QBR deck is in Drive. Review before Thursday's call.",
  "Acme Corp onboarding session 1 went well. They loved the calendar integration.",
  "Orion Health is asking for the audit log timeline. Gabriel, can you confirm?",
  "Beacon Analytics wants to expand to 30 seats. Nina is handling the paperwork.",
  "Summit Capital is at risk — DAU rate dropped to 55%. Scheduling a check-in call.",
  "Harbor Tech onboarding is complete. Full team adoption in 3 weeks — great outcome.",
  "Riviera Hotels has questions about data residency for their EU operation.",
  "PineCrest Schools wants to add 10 seats. Straightforward expansion.",
  "Northwind renewal is tracking green. Nadia is leading the commercial discussion.",
  "New NPS responses are in — average 7.8. Best score in 6 months.",
];

const DM_MSGS = [
  "Hey, do you have 5 minutes to chat about the PR?",
  "Thanks for the quick review! I'll address those comments now.",
  "Are you joining the design crit today?",
  "Just flagging — I'll be OOO tomorrow.",
  "The recording pipeline is looking good. Can you take a final pass?",
  "Can you add me to the Northwind calendar invite?",
  "Good call on the breadcrumb change. Much cleaner.",
  "I updated the doc based on your comments. Take another look when you can.",
  "The load test results are impressive. Nice work on the pooling design.",
  "Are you free for a quick 1:1 before standup?",
  "I saw the PR — the cursor encoding fix looks right to me.",
  "The sprint velocity is looking great this sprint.",
  "Thanks for covering on-call while I was out.",
  "Can we sync on the OKR scores before the review?",
  "The beta feedback from Northwind is super positive.",
];

// ---------------------------------------------------------------------------
// Room definitions
// ---------------------------------------------------------------------------

interface RoomDef {
  readonly idx: number;
  readonly kind: "chat_room" | "chat_dm";
  readonly name: string;
  readonly topic: string;
  readonly isPrivate: boolean;
  readonly memberIdxs: readonly number[];  // indices into ACTORS array
  readonly msgPool: readonly string[];
  readonly msgCount: number;  // total messages to generate
}

const ROOMS: readonly RoomDef[] = [
  // --- Public spaces (idx 1-15) ---
  { idx: 1,  kind: "chat_room", name: "general",         topic: "Company-wide announcements and watercooler.", isPrivate: false, memberIdxs: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24], msgPool: GENERAL_MSGS, msgCount: 300 },
  { idx: 2,  kind: "chat_room", name: "engineering",     topic: "Engineering discussion, deploys, incident chatter.", isPrivate: false, memberIdxs: [0,1,2,3,4,8,9,10,12,15,16,20,21,22,23,24], msgPool: ENGINEERING_MSGS, msgCount: 500 },
  { idx: 3,  kind: "chat_room", name: "product",         topic: "Product discussions and updates.", isPrivate: false, memberIdxs: [0,1,4,5,6,7,10,11,13,17,18,19,20,22], msgPool: PRODUCT_MSGS, msgCount: 300 },
  { idx: 4,  kind: "chat_room", name: "design",          topic: "Design crits, mockups, and the design system.", isPrivate: false, memberIdxs: [0,1,4,6,7,10,11,19,20], msgPool: DESIGN_MSGS, msgCount: 200 },
  { idx: 5,  kind: "chat_room", name: "infra",           topic: "Infrastructure, deploys, SRE.", isPrivate: false, memberIdxs: [0,1,2,8,9,10,15,21,22,23,24], msgPool: INFRA_MSGS, msgCount: 200 },
  { idx: 6,  kind: "chat_room", name: "hiring",          topic: "Hiring updates and pipeline.", isPrivate: true, memberIdxs: [0,1,8,9,21,22,23], msgPool: HIRING_MSGS, msgCount: 150 },
  { idx: 7,  kind: "chat_room", name: "customer-success", topic: "Customer success updates.", isPrivate: true, memberIdxs: [0,1,13,14,15,20], msgPool: CUSTOMER_MSGS, msgCount: 150 },
  { idx: 8,  kind: "chat_room", name: "finance",         topic: "Finance and expense updates.", isPrivate: true, memberIdxs: [0,1,5,8,14], msgPool: FINANCE_MSGS, msgCount: 100 },
  { idx: 9,  kind: "chat_room", name: "backend",         topic: "Backend team discussion.", isPrivate: false, memberIdxs: [0,1,2,3,8,9,10,21,22,23,24], msgPool: ENGINEERING_MSGS, msgCount: 400 },
  { idx: 10, kind: "chat_room", name: "frontend",        topic: "Frontend team discussion.", isPrivate: false, memberIdxs: [0,1,3,4,8,12,19,20], msgPool: ENGINEERING_MSGS, msgCount: 300 },
  { idx: 11, kind: "chat_room", name: "data",            topic: "Data engineering and analytics.", isPrivate: false, memberIdxs: [0,1,5,6,9,18], msgPool: PRODUCT_MSGS, msgCount: 150 },
  { idx: 12, kind: "chat_room", name: "offsite-2026",    topic: "Offsite planning — June 11-13 at The Foundry.", isPrivate: false, memberIdxs: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24], msgPool: GENERAL_MSGS, msgCount: 100 },
  { idx: 13, kind: "chat_room", name: "enterprise-launch", topic: "Enterprise launch coordination.", isPrivate: true, memberIdxs: [0,1,5,7,9,13,14,20,21], msgPool: PRODUCT_MSGS, msgCount: 200 },
  { idx: 14, kind: "chat_room", name: "security",        topic: "Security discussions and SOC 2 prep.", isPrivate: true, memberIdxs: [0,1,7,8,9,13], msgPool: INFRA_MSGS, msgCount: 150 },
  { idx: 15, kind: "chat_room", name: "random",          topic: "Off-topic, memes, and miscellany.", isPrivate: false, memberIdxs: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], msgPool: GENERAL_MSGS, msgCount: 200 },
  // --- Private/project spaces (idx 16-20) ---
  { idx: 16, kind: "chat_room", name: "soc2-prep",       topic: "SOC 2 evidence collection and gap remediation.", isPrivate: true, memberIdxs: [0,7,8,13,24], msgPool: INFRA_MSGS, msgCount: 100 },
  { idx: 17, kind: "chat_room", name: "assistant-beta",  topic: "Assistant chaining beta feedback.", isPrivate: true, memberIdxs: [0,1,2,4,5,6,9,21], msgPool: PRODUCT_MSGS, msgCount: 150 },
  { idx: 18, kind: "chat_room", name: "meet-recording",  topic: "Meet recording pipeline project.", isPrivate: true, memberIdxs: [0,1,2,3,8,9,24], msgPool: ENGINEERING_MSGS, msgCount: 150 },
  { idx: 19, kind: "chat_room", name: "mobile",          topic: "Mobile app development.", isPrivate: false, memberIdxs: [0,1,3,8,12], msgPool: ENGINEERING_MSGS, msgCount: 150 },
  { idx: 20, kind: "chat_room", name: "qa",              topic: "QA and testing coordination.", isPrivate: false, memberIdxs: [0,1,2,3,4,8,16,21], msgPool: ENGINEERING_MSGS, msgCount: 150 },
  // --- DMs (idx 21-30) ---
  { idx: 21, kind: "chat_dm",  name: "Avery Park ↔ Hannah Price",  topic: "", isPrivate: true, memberIdxs: [0,9],  msgPool: DM_MSGS, msgCount: 80 },
  { idx: 22, kind: "chat_dm",  name: "Avery Park ↔ Diana Singh",   topic: "", isPrivate: true, memberIdxs: [0,5],  msgPool: DM_MSGS, msgCount: 60 },
  { idx: 23, kind: "chat_dm",  name: "Avery Park ↔ Alex Torres",   topic: "", isPrivate: true, memberIdxs: [0,2],  msgPool: DM_MSGS, msgCount: 60 },
  { idx: 24, kind: "chat_dm",  name: "Riley Chen ↔ Ben Hayes",     topic: "", isPrivate: true, memberIdxs: [1,3],  msgPool: DM_MSGS, msgCount: 60 },
  { idx: 25, kind: "chat_dm",  name: "Riley Chen ↔ Celia Wright",  topic: "", isPrivate: true, memberIdxs: [1,4],  msgPool: DM_MSGS, msgCount: 60 },
  { idx: 26, kind: "chat_dm",  name: "Riley Chen ↔ Evan Brooks",   topic: "", isPrivate: true, memberIdxs: [1,6],  msgPool: DM_MSGS, msgCount: 50 },
  { idx: 27, kind: "chat_dm",  name: "Avery Park ↔ Ulrich Weber",  topic: "", isPrivate: true, memberIdxs: [0,22], msgPool: DM_MSGS, msgCount: 50 },
  { idx: 28, kind: "chat_dm",  name: "Avery Park ↔ Vera Stone",    topic: "", isPrivate: true, memberIdxs: [0,23], msgPool: DM_MSGS, msgCount: 50 },
  { idx: 29, kind: "chat_dm",  name: "Riley Chen ↔ Nina Patel",    topic: "", isPrivate: true, memberIdxs: [1,15], msgPool: DM_MSGS, msgCount: 50 },
  { idx: 30, kind: "chat_dm",  name: "Riley Chen ↔ Fiona Marsh",   topic: "", isPrivate: true, memberIdxs: [1,7],  msgPool: DM_MSGS, msgCount: 50 },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedChat(sql: SeedSql, orgId: string): Promise<{ rooms: number; messages: number }> {
  let totalMessages = 0;

  for (const room of ROOMS) {
    const threadId = uid("f700", room.idx);
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, ${room.kind}, ${room.name}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict (id) do nothing
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name, topic, is_private, metadata)
      values (${threadId}, ${orgId}, ${room.name}, ${room.topic}, ${room.isPrivate},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, dm: room.kind === "chat_dm" })})
      on conflict (thread_id) do update
      set name = excluded.name, topic = excluded.topic, metadata = excluded.metadata
    `;

    // Permissions for all members.
    for (const memberIdx of room.memberIdxs) {
      const actorId = actorAt(memberIdx);
      const role = (actorId === ADMIN_ACTOR || actorId === USER_ACTOR) ? "owner" : "member";
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${orgId}, ${actorId}, 'thread', ${threadId}, ${role}, ${ADMIN_ACTOR})
        on conflict do nothing
      `;
    }

    // Generate messages in batches.
    const memberIdxs = room.memberIdxs;
    let lastMessageId = "";
    const msgCount = room.msgCount;

    // Spread messages across last 90 days.
    for (let mi = 0; mi < msgCount; mi++) {
      const messageId = uid("f800", room.idx * 200 + (mi % 200));
      // Deterministic time spread: newer messages closer to now.
      const daysBack  = Math.floor((msgCount - mi) / msgCount * 89) + 1;
      const hourOfDay = 8 + (mi % 10);
      const minute    = (mi * 13) % 60;
      const sentAt    = daysFromNow(-daysBack, hourOfDay, minute);

      // Pick actor and body deterministically.
      const actorIdx  = memberIdxs[mi % memberIdxs.length] ?? 0;
      const actorId   = actorAt(actorIdx);
      const body      = room.msgPool[mi % room.msgPool.length] ?? "...";

      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${messageId}, ${orgId}, ${threadId}, ${actorId}, 'chat', ${body}, 'plain',
          ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })},
          ${sentAt}
        )
        on conflict (id) do nothing
      `;
      lastMessageId = messageId;
      totalMessages++;
    }

    // Read receipts for both login actors if they're members.
    for (const actorId of [ADMIN_ACTOR, USER_ACTOR]) {
      if (!room.memberIdxs.some((idx) => actorAt(idx) === actorId)) {
        continue;
      }
      if (lastMessageId === "") continue;
      await sql`
        insert into chat_read_receipts (thread_id, actor_id, org_id, last_read_message_id, last_read_at)
        values (${threadId}, ${actorId}, ${orgId}, ${lastMessageId}, ${daysFromNow(0, 12)})
        on conflict (thread_id, actor_id) do update
        set last_read_message_id = excluded.last_read_message_id,
            last_read_at = excluded.last_read_at
      `;
    }
  }

  // Reactions on a selection of messages.
  const REACTIONS = [
    { roomIdx: 1, mi: 0,  actorIdx: 2, emoji: "wave"          },
    { roomIdx: 1, mi: 2,  actorIdx: 1, emoji: "tada"           },
    { roomIdx: 1, mi: 5,  actorIdx: 3, emoji: "fork_and_knife"  },
    { roomIdx: 2, mi: 0,  actorIdx: 1, emoji: "eyes"           },
    { roomIdx: 2, mi: 2,  actorIdx: 0, emoji: "white_check_mark"},
    { roomIdx: 3, mi: 1,  actorIdx: 0, emoji: "thumbsup"       },
    { roomIdx: 4, mi: 0,  actorIdx: 1, emoji: "art"            },
    { roomIdx: 9, mi: 0,  actorIdx: 0, emoji: "rocket"         },
    { roomIdx: 9, mi: 4,  actorIdx: 1, emoji: "bug"            },
    { roomIdx: 13, mi: 2, actorIdx: 0, emoji: "muscle"         },
  ];

  for (const r of REACTIONS) {
    const messageId = uid("f800", r.roomIdx * 200 + (r.mi % 200));
    const actorId   = actorAt(r.actorIdx);
    await sql`
      insert into chat_reactions (message_id, actor_id, org_id, emoji)
      values (${messageId}, ${actorId}, ${orgId}, ${r.emoji})
      on conflict do nothing
    `;
  }

  // Pin one message in #engineering and one in #backend.
  for (const pinRoomIdx of [2, 9]) {
    const pinMsgId = uid("f800", pinRoomIdx * 200 + 0);
    const threadId = uid("f700", pinRoomIdx);
    await sql`
      insert into chat_pins (message_id, thread_id, org_id, pinned_by_actor_id, metadata)
      values (${pinMsgId}, ${threadId}, ${orgId}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict do nothing
    `;
  }

  return { rooms: ROOMS.length, messages: totalMessages };
}
