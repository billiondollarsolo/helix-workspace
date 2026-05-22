/**
 * Seed ~300 mail threads (~600 messages) for the large workspace seed.
 *
 * Threads use IDs in the c000 group (threads) and c100 group (messages).
 * Mail labels use the c200 group.
 * Attachment objects use the c300 group.
 */

import {
  ADMIN_ACTOR,
  USER_ACTOR,
  WORKSPACE_SEED_LARGE_SOURCE,
  daysFromNow,
  grantBoth,
  json,
  sha,
  uid,
  LARGE_TEAM,
  type SeedSql,
} from "./config.js";

// ---------------------------------------------------------------------------
// Label definitions
// ---------------------------------------------------------------------------

// Slugs are prefixed with "ls-" so they never collide with light-seed labels
// (which use plain "engineering", "finance", etc.).
const LABELS = [
  { idx: 1, slug: "ls-engineering",   name: "Engineering",   color: "#9334e6" },
  { idx: 2, slug: "ls-product",       name: "Product",       color: "#1a73e8" },
  { idx: 3, slug: "ls-design",        name: "Design",        color: "#e8710a" },
  { idx: 4, slug: "ls-finance",       name: "Finance",       color: "#137333" },
  { idx: 5, slug: "ls-hiring",        name: "Hiring",        color: "#f9ab00" },
  { idx: 6, slug: "ls-customer",      name: "Customer",      color: "#12b5cb" },
  { idx: 7, slug: "ls-important",     name: "Important",     color: "#ea4335" },
  { idx: 8, slug: "ls-team",          name: "Team",          color: "#4285f4" },
  { idx: 9, slug: "ls-legal",         name: "Legal",         color: "#5c35cc" },
  { idx: 10, slug: "ls-security",     name: "Security",      color: "#c5221f" },
] as const;

// ---------------------------------------------------------------------------
// Realistic content pools
// ---------------------------------------------------------------------------

const SENDER_POOL = [
  ...LARGE_TEAM.map((m) => ({ address: m.email, name: m.displayName })),
  { address: "billing@helixcloud.example",   name: "Helix Cloud Billing"     },
  { address: "security@helix.local",         name: "Helix Security"          },
  { address: "status@helix.local",           name: "Helix Status"            },
  { address: "no-reply@helix.local",         name: "Helix"                   },
  { address: "alerts@pagerduty.example",     name: "PagerDuty"               },
  { address: "notifications@github.com",     name: "GitHub"                  },
  { address: "marketing@devconf.example",    name: "DevConf Team"            },
  { address: "news@techdigest.example",      name: "TechDigest"              },
  { address: "info@cloudsupplier.example",   name: "CloudSupplier"           },
  { address: "hr@helix.local",               name: "Helix HR"                },
  { address: "legal@helix.local",            name: "Helix Legal"             },
  { address: "noreply@jira.example",         name: "Jira"                    },
  { address: "bot@datadog.example",          name: "Datadog"                 },
  { address: "recruit@lever.example",        name: "Lever ATS"               },
];

type Category = "primary" | "updates" | "promotions" | "social";

interface ThreadTemplate {
  readonly subjectFn: (i: number) => string;
  readonly category: Category;
  readonly labels: readonly string[];
  readonly bodyFn: (i: number) => readonly string[];
  readonly count: number;
  readonly readChance: number;
  readonly starredChance?: number;
  readonly archivedChance?: number;
  readonly senderIdx: (i: number) => number;
  readonly hasAttachment?: boolean;
}

// ---------------------------------------------------------------------------
// Thread templates — each template produces `count` threads.
// ---------------------------------------------------------------------------

function pick<T>(arr: readonly T[], seed: number): T {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return arr[seed % arr.length]!;
}

const TEMPLATES: readonly ThreadTemplate[] = [
  // --- Engineering: PR reviews (40 threads)
  {
    count: 40,
    subjectFn: (i) => `[helix/platform] PR #${String(500 + i)} — ${pick(["Fix","Refactor","Add","Update","Remove","Improve","Optimize","Migrate"], i)} ${pick(["auth flow","cache layer","mail parser","calendar sync","search index","API rate limiter","docs store","chat fanout","drive upload","meet signaling"], i)}`,
    category: "updates",
    labels: ["ls-engineering"],
    senderIdx: (i) => i % 5,
    bodyFn: (i) => [`${pick(["Alex Torres","Ben Hayes","Celia Wright","Ivan Petrov","Will Cross"], i)} opened pull request #${String(500+i)}.\n\n  ${pick(["Fix","Refactor","Add","Update","Remove"], i)} ${pick(["auth flow to use refresh tokens","cache layer to reduce DB hits","mail parser edge case on attachments","calendar sync retry logic","search index update path"], i)}\n\n  +${String(50 + i*3)} −${String(10 + i)} across ${String(2 + (i%5))} files\n\nReview on GitHub.`],
    readChance: 0.6,
  },
  // --- Engineering: Incident alerts (20 threads)
  {
    count: 20,
    subjectFn: (i) => `[${pick(["P1","P2","P3"], i)} Incident] ${pick(["Mail delivery delayed","Drive upload errors","Calendar sync lag","Search unavailable","Meet room failures","Auth timeouts","Database slow queries","Cache miss spike","API 500s","Storage quota alert"], i)}`,
    category: "updates",
    labels: ["ls-engineering", "ls-important"],
    senderIdx: (i) => 8 + (i % 3),  // Ivan (SRE), Omar (Infra), Will (DevOps)
    bodyFn: (i) => {
      const errRate = String(2 + i);
      return [
        `${pick(["P1","P2","P3"], i)} incident declared at ${String(9 + i % 12)}:${i % 6 === 0 ? "00" : String(i % 60).padStart(2,"0")} UTC.\n\nService: ${pick(["mail","drive","calendar","search","meet"], i)}\nImpact: ${pick(["All writes failing",`Elevated error rate (${errRate}%)`,"Latency >5s","Partial outage in us-east-1"], i)}\n\nIC: ${pick(["Ivan Petrov","Will Cross","Omar Hassan"], i)}\nBridge: meet.helix.local/incident-bridge\n\nUpdates will follow every 15 minutes.`,
        `Update — ${String(30 + i*3)} minutes in.\n\n${pick(["Root cause identified: bad deploy. Rolling back now.","Mitigation in place. Monitoring for full recovery.","Escalated to vendor — waiting on their response.","False positive confirmed. Closing incident."], i)}`,
      ];
    },
    readChance: 0.85,
    starredChance: 0.3,
  },
  // --- Product: Feature discussions (30 threads)
  {
    count: 30,
    subjectFn: (i) => `${pick(["Proposal:","RFC:","Discussion:","Feedback request:","Question:"], i)} ${pick(["keyboard shortcuts MVP","offline Docs scope","assistant chaining UX","Sheets formula engine","Meet recording controls","Drive folder sharing model","Calendar RSVP flows","search ranking tuning","mail threading rules","chat notification batching"], i)}`,
    category: "primary",
    labels: ["ls-product"],
    senderIdx: (i) => 3 + (i % 4),  // Diana, Evan, Fiona, or Jade
    bodyFn: (i) => [
      `Hi team,\n\nOpening a discussion on ${pick(["keyboard shortcuts MVP","offline Docs scope","the assistant chaining UX","the Sheets formula engine roadmap","Meet recording controls","Drive folder sharing model"], i)}.\n\nBackground: ${pick(["Customers are asking for this consistently.","We've scoped this for Q3 but need alignment on approach.","The current design has some rough edges we should address before launch.","This came up in the last customer call and deserves a proper decision."], i)}\n\nMy current thinking is attached. Would love a response by EOW.`,
      `Thanks for writing this up. My take:\n\n${pick(["Strong agree on the approach — let's move forward.","I have concerns about the scope. Can we narrow it?","The proposal looks good but we need to align with design first.","This is the right direction. I'll set up a deeper session."], i)}`,
    ],
    readChance: 0.5,
    starredChance: 0.2,
  },
  // --- Hiring: Candidate threads (25 threads)
  {
    count: 25,
    subjectFn: (i) => `${pick(["Interview feedback:","Loop debrief:","Offer discussion:","Candidate pipeline:","Sourcing update:"], i)} ${pick(["Backend Engineer","Frontend Engineer","Staff Engineer","Product Manager","UX Researcher","Data Engineer","Security Engineer","SRE","QA Lead","Solutions Engineer"], i)} (${pick(["Req #","Role #","Req "], i)}${String(200+i)})`,
    category: "primary",
    labels: ["ls-hiring"],
    senderIdx: () => 21,  // Vera Stone (Recruiting Lead)
    bodyFn: (i) => [`${pick(["Loop debrief for","Feedback on","Offer discussion for","Pipeline update for"], i)} the ${pick(["Backend","Frontend","Staff","PM","UX"], i)} role.\n\nCandidate: ${pick(["Jordan Mwangi","Preet Arora","Sophie Lindqvist","Dev Sharma","Kai Fujita","Ana Becker","Sam Osei","Mia Larsson"], i)}\nStage: ${pick(["Phone screen","Technical round","Design exercise","Onsite","Offer","Rejected","Withdrawn"], i)}\n\nNotes: ${pick(["Strong systems design, recommend advancing.","Good cultural fit but gaps in required skills.","Excellent communication, weakest on depth.","Offer accepted! Starting in 3 weeks.","Candidate withdrew — accepted elsewhere."], i)}`],
    readChance: 0.65,
  },
  // --- Customer: Success threads (25 threads)
  {
    count: 25,
    subjectFn: (i) => `${pick(["Re:","FWD:",""], i)} ${pick(["Northwind","Acme Corp","Riviera Hotels","Beacon Analytics","Orion Health","Summit Capital","Nexus Media","Harbor Tech","Vantage Retail","PineCrest Schools"], i)} — ${pick(["onboarding check-in","renewal discussion","support escalation","QBR prep","expansion opportunity","feature request","billing inquiry","contract amendment","integration question","access issue"], i)}`,
    category: "primary",
    labels: ["ls-customer"],
    senderIdx: (i) => 13 + (i % 2),  // Nina Patel or Marco Vitale
    bodyFn: (i) => [`Customer contact at ${pick(["Northwind","Acme Corp","Riviera Hotels","Beacon Analytics","Orion Health"], i)} reached out about ${pick(["their onboarding timeline","the upcoming renewal","a billing discrepancy","a feature gap we've heard before","a data export request","access provisioning for new hires"], i)}.\n\nI'm handling this but looping you in for context. More details in the CRM.\n\nAction needed: ${pick(["Reply to confirm next steps","Review the contract terms","Check if this feature is on the roadmap","Approve the discount","Escalate to engineering"], i)} by ${pick(["Friday","EOW","next Monday","COB today"], i)}.`],
    readChance: 0.6,
    starredChance: 0.15,
  },
  // --- Finance: Billing and expenses (20 threads)
  {
    count: 20,
    subjectFn: (i) => `${pick(["Invoice","Expense report","Budget update","Payment confirmation","Vendor renewal","PO request","Cost analysis","Financial summary"], i)} — ${pick(["May 2026","Q2 2026","June 2026","FY2026 Q3","April 2026"], i)}`,
    category: "updates",
    labels: ["ls-finance"],
    senderIdx: (i) => (i % 2 === 0) ? SENDER_POOL.findIndex(s => s.address === "billing@helixcloud.example") : 4, // billing or Evan
    bodyFn: (i) => [`${pick(["Your invoice for","An expense report from","Budget update for","Payment of"], i)} ${pick(["$1,200.00","$4,850.00","$320.00","$8,100.00","$670.00","$2,300.00"], i)} is ${pick(["now available.","due by end of month.","approved and processing.","pending your review.","requires your signature."], i)}\n\nPlease review and take any required action before ${pick(["June 1","June 15","end of month","Friday"], i)}.`],
    readChance: 0.8,
    hasAttachment: true,
  },
  // --- Security: Alerts and compliance (15 threads)
  {
    count: 15,
    subjectFn: (i) => `${pick(["Security alert:","Access review:","Compliance notice:","Audit finding:","Vulnerability report:","Policy update:"], i)} ${pick(["new sign-in detected","third-party access review","SOC 2 audit prep","dependency vulnerability","password policy change","MFA enforcement","API key rotation","GDPR data request","penetration test results","access log anomaly"], i)}`,
    category: "updates",
    labels: ["ls-security"],
    senderIdx: (i) => {
      const secIdx = SENDER_POOL.findIndex(s => s.address === "security@helix.local");
      return (i % 2 === 0) ? secIdx : 6; // security@ or Gabriel Luna
    },
    bodyFn: (i) => [`${pick(["We detected","Please review","Your attention is needed on","Action required:"], i)} ${pick(["a new sign-in to your account from an unrecognized device.","a third-party application with broad permissions.","the upcoming SOC 2 audit — prep materials attached.","a medium-severity dependency vulnerability in a production service.","the new password policy taking effect next week."], i)}\n\n${pick(["If this was you, no action needed.","Please rotate your credentials as a precaution.","Review the attached report and confirm no false positives.","Patch scheduled for Saturday maintenance window."], i)}`],
    readChance: 0.9,
    starredChance: 0.2,
  },
  // --- Updates/notifications (30 threads)
  {
    count: 30,
    subjectFn: (i) => `${pick(["Priya Raman","Morgan Diaz","Diana Singh","Celia Wright","Sam Walker","Jade Osei","Quinn Reed"], i % 7)} ${pick(["shared a document","mentioned you in a comment","invited you to a calendar event","shared a folder","assigned you to a task","left a comment on","updated the doc"], i % 8)} — "${pick(["Q3 Roadmap","Brand Guidelines","UX Research Findings","Engineering Wiki","OKR Tracker","Onboarding Guide","Content Calendar","Budget Forecast","Competitor Analysis","Product Spec"], i % 10)}"`,
    category: "updates",
    labels: [],
    senderIdx: () => SENDER_POOL.findIndex(s => s.address === "no-reply@helix.local"),
    bodyFn: (i) => [`${pick(["Priya Raman","Morgan Diaz","Diana Singh","Celia Wright"], i % 4)} ${pick(["shared","mentioned you in a comment on","invited you to","updated"], i % 4)} "${pick(["Q3 Roadmap","Brand Guidelines","UX Research Findings","Engineering Wiki","OKR Tracker"], i % 5)}".\n\nOpen the item to view and respond.`],
    readChance: 0.5,
  },
  // --- Promotions and newsletters (20 threads)
  {
    count: 20,
    subjectFn: (i) => pick([
      "Your weekly product update from Helix",
      "Early bird pricing ends soon — DevConf 2026",
      "Join the Helix beta community",
      "What's new this month in your tools",
      "50% off annual plans — limited time",
      "New integrations available now",
      "Your cloud costs: monthly summary",
      "This week in developer tools",
      "Exclusive webinar: AI-powered workflows",
      "Tips & tricks: get more from Helix",
    ], i),
    category: "promotions",
    labels: [],
    senderIdx: (i) => {
      const idx = SENDER_POOL.findIndex(s => s.address === "news@techdigest.example");
      return i % 3 === 0 ? idx : SENDER_POOL.findIndex(s => s.address === "marketing@devconf.example");
    },
    bodyFn: (i) => [pick([
      "Here is what shipped this week across the Helix platform. Full changelog on the blog.",
      "Early bird tickets for DevConf 2026 end Friday. Three days of talks on systems and AI.",
      "Join the beta community for early feature previews and direct access to the team.",
      "Your monthly usage summary is ready. Log in to the billing console to view details.",
      "Limited-time offer: upgrade to annual and save 40%. Offer ends Sunday.",
    ], i)],
    readChance: 0.3,
  },
  // --- Team: Internal threads (25 threads)
  {
    count: 25,
    subjectFn: (i) => `${pick(["Team lunch","Offsite planning","All-hands agenda","Shoutout:","Welcome:","Thank you:","Reminder:","Check-in:"], i % 8)} ${pick(["— vote by Friday","— agenda attached","— please RSVP","to Alex Torres","to Ben Hayes","to Nina Patel — great customer call","about the sprint review","on expense reports"], i % 8)}`,
    category: "primary",
    labels: ["ls-team"],
    senderIdx: (i) => i % 8,  // rotate through first 8 teammates
    bodyFn: (i) => [`${pick(["Quick note:","Hey team,","Hi everyone,","Friendly reminder:"], i % 4)} ${pick(["Lunch is Friday at 12:30 — let Fiona know if you can make it.","The offsite agenda is in Drive. Please review before next week.","Shoutout to Alex for the fast turnaround on the auth fix!","Expense reports are due end of week — use the shared tracker.","Welcome to Ben, who is joining the backend team next Monday.","All-hands is next Thursday at 4pm. Agenda coming soon.","The sprint review notes are in the Engineering folder."], i % 7)}`],
    readChance: 0.7,
  },
  // --- Legal: Contracts and compliance (10 threads)
  {
    count: 10,
    subjectFn: (i) => `${pick(["Contract review:","NDA request:","Legal hold:","DPA amendment:","IP assignment:","Vendor agreement:","Data processing agreement:","License renewal:"], i % 8)} ${pick(["Northwind Enterprise","Acme Corp","CloudSupplier","DevConf sponsorship","Beacon Analytics","new hire offer letter"], i % 6)}`,
    category: "primary",
    labels: ["ls-legal"],
    senderIdx: () => 11,  // Lena Fischer (Legal Counsel)
    bodyFn: (i) => [`${pick(["Please review","Routing for signature:","Action required on","Legal hold notice for","Flagging for your awareness:"], i % 5)} the ${pick(["master services agreement","NDA","data processing agreement","IP assignment form","vendor contract"], i % 5)} for ${pick(["Northwind","Acme Corp","CloudSupplier"], i % 3)}.\n\nExpected turnaround: ${pick(["2 business days","EOW","by next Monday"], i % 3)}. Questions to lena@helix.local.`],
    readChance: 0.75,
    hasAttachment: true,
  },
  // --- Sent items (10 threads)
  {
    count: 10,
    subjectFn: (i) => `${pick(["Status update:","FYI:","Following up on:","Action item from:","Quick question about:"], i % 5)} ${pick(["the Northwind integration","last week's all-hands","the Q3 roadmap","the infra migration","the hiring pipeline","the design review","the sprint retro","customer feedback Q2"], i % 8)}`,
    category: "primary",
    labels: ["sent" as const],
    senderIdx: () => -1,  // special: user@helix.local
    bodyFn: (i) => [`${pick(["Following up on","Status update on","Quick note about"], i % 3)} ${pick(["the Northwind integration issue","the Q3 roadmap review","the infra migration timeline","the design system refresh","the hiring pipeline for backend roles"], i % 5)}.\n\n${pick(["Progress is on track. More details in the doc.","I'll have an update by EOW.","No blockers currently. Full summary attached.","Waiting on a response from the vendor.","This is resolved — closing out the thread."], i % 5)}`],
    readChance: 1,
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedMail(sql: SeedSql, orgId: string): Promise<number> {
  // Insert labels.
  for (const label of LABELS) {
    const labelId = uid("c200", label.idx);
    await sql`
      insert into mail_labels (id, org_id, owner_actor_id, slug, name, color, sort_order)
      values (
        ${labelId}, ${orgId}, null, ${label.slug}, ${label.name}, ${label.color}, ${label.idx * 10}
      )
      on conflict (id) do update set name = excluded.name, color = excluded.color
    `;
  }

  let threadIdx = 0;
  let threadCount = 0;

  for (const tmpl of TEMPLATES) {
    for (let i = 0; i < tmpl.count; i++) {
      threadIdx++;
      const threadId = uid("c000", threadIdx);
      const isSent = tmpl.labels.includes("sent");
      const subject = tmpl.subjectFn(i);
      const bodies = tmpl.bodyFn(i);
      const daysAgo = (threadIdx % 90) + 1; // spread across past 90 days
      const sentAt = daysFromNow(-daysAgo, 7 + (threadIdx % 10), (threadIdx * 7) % 60);
      const read = Math.abs(Math.sin(threadIdx)) < tmpl.readChance;
      const starred = tmpl.starredChance !== undefined && Math.abs(Math.cos(threadIdx * 2)) < tmpl.starredChance;
      const archived = tmpl.archivedChance !== undefined && Math.abs(Math.sin(threadIdx * 3)) < tmpl.archivedChance;

      let senderObj: { address: string; name: string };
      if (isSent) {
        senderObj = { address: "user@helix.local", name: "Riley Chen" };
      } else {
        const si = tmpl.senderIdx(i);
        if (si < 0 || si >= SENDER_POOL.length) {
          senderObj = { address: "admin@helix.local", name: "Avery Park" };
        } else {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          senderObj = SENDER_POOL[si]!;
        }
      }

      await sql`
        insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
        values (${threadId}, ${orgId}, 'mail', ${subject}, ${ADMIN_ACTOR},
          ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, messageId: `<${threadId}@helix.local>` })})
        on conflict (id) do nothing
      `;

      const ownTo = [
        { address: "admin@helix.local", name: "Avery Park" },
        { address: "user@helix.local",  name: "Riley Chen" },
      ];

      // Insert messages (batch for performance)
      for (const [mi, body] of bodies.entries()) {
        const messageId = uid("c100", threadIdx * 5 + mi);
        const direction = isSent ? "outbound" : "inbound";
        const msgSentAt = new Date(sentAt.getTime() + mi * 3_600_000);
        await sql`
          insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
          values (
            ${messageId}, ${orgId}, ${threadId}, ${ADMIN_ACTOR}, 'mail', ${body}, 'plain',
            ${json(sql, {
              source: WORKSPACE_SEED_LARGE_SOURCE,
              direction,
              from: senderObj,
              to: ownTo,
              cc: [],
              bcc: [],
              subject: mi === 0 ? subject : `Re: ${subject}`,
              messageId: `<${messageId}@helix.local>`,
              inReplyTo: mi === 0 ? null : `<${uid("c100", threadIdx * 5 + mi - 1)}@helix.local>`,
              references: [],
            })},
            ${msgSentAt}
          )
          on conflict (id) do nothing
        `;
        // Attachment on first message when needed.
        if (tmpl.hasAttachment === true && mi === 0) {
          const objectId = uid("c300", threadIdx);
          const attBody = `Attachment for "${subject}"`;
          await sql`
            insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
            values (
              ${objectId}, ${orgId}, ${ADMIN_ACTOR}, 'mail_attachment',
              ${`mail/${objectId}/document.pdf`}, 'application/pdf',
              ${Buffer.byteLength(attBody, "utf8")}, ${sha(attBody + String(threadIdx))},
              ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, filename: `attachment-${String(threadIdx)}.pdf`, contentId: null })}
            )
            on conflict (id) do nothing
          `;
          await sql`
            insert into message_attachments (message_id, object_id, disposition)
            values (${messageId}, ${objectId}, 'attachment')
            on conflict do nothing
          `;
          await grantBoth(sql, orgId, "object", objectId, "owner");
        }
      }

      // Per-actor thread state.
      const labelSlugs = tmpl.labels.includes("sent")
        ? ["sent"]
        : tmpl.labels.filter((l) => l !== "sent");

      for (const actorId of [ADMIN_ACTOR, USER_ACTOR]) {
        await sql`
          insert into mail_thread_state (
            actor_id, thread_id, org_id, labels, archived_at, deleted_at,
            snoozed_until, read_at, starred, category, updated_at
          )
          values (
            ${actorId}, ${threadId}, ${orgId},
            ${sql.array([...labelSlugs, ...(!labelSlugs.includes("sent") && !labelSlugs.includes("drafts") ? ["inbox"] : [])])},
            ${archived ? sentAt : null},
            null,
            null,
            ${read ? sentAt : null},
            ${starred},
            ${tmpl.category},
            now()
          )
          on conflict (actor_id, thread_id) do update
          set labels     = excluded.labels,
              archived_at = excluded.archived_at,
              read_at    = excluded.read_at,
              starred    = excluded.starred,
              category   = excluded.category,
              updated_at = now()
        `;
      }
      await grantBoth(sql, orgId, "thread", threadId, "owner");
      threadCount++;
    }
  }

  return threadCount;
}
