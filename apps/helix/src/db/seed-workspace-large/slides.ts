/**
 * Seed ~10 slide decks with 8-20 slides each, covering all 6 layouts.
 *
 * Decks:  h000 group
 * Slides: h100 group (deck.idx * 30 + slidePosition)
 */

import {
  ADMIN_ACTOR,
  FOLDER,
  WORKSPACE_SEED_LARGE_SOURCE,
  grantBoth,
  json,
  uid,
  type SeedSql,
} from "./config.js";

interface SlideDef {
  readonly layout: "title" | "agenda" | "bullets" | "stats" | "split" | "image";
  readonly content: Record<string, unknown>;
  readonly notes: string;
}

interface DeckDef {
  readonly idx: number;
  readonly title: string;
  readonly folderId: string;
  readonly slides: readonly SlideDef[];
}

const DECKS: readonly DeckDef[] = [
  // Deck 1: Q3 Roadmap (10 slides)
  {
    idx: 1,
    title: "Q3 Roadmap — Full Presentation",
    folderId: FOLDER.roadmap,
    slides: [
      { layout: "title", content: { layout: "title", title: "Q3 Roadmap", eyebrow: "Helix Product", subtitle: "Locking priorities and sequencing for the quarter" }, notes: "Welcome. Goal: leave with a locked roadmap." },
      { layout: "agenda", content: { layout: "agenda", title: "Agenda", items: ["Q2 recap", "Where we are today", "Three candidate bets", "Sequencing & trade-offs", "Resource allocation", "Decisions needed"] }, notes: "Run the agenda briefly before the Q2 recap." },
      { layout: "stats", content: { layout: "stats", title: "Q2 recap", subtitle: "What we shipped", stats: [{ value: "14", label: "Features shipped", note: "vs 11 planned" }, { value: "40%", label: "Search latency improvement", note: "" }, { value: "0", label: "P1 incidents in May", note: "Down from 2" }] }, notes: "Emphasize momentum before asking hard prioritization questions." },
      { layout: "bullets", content: { layout: "bullets", title: "Three candidate bets", items: ["1. Assistant automation — chained, confirmed multi-step actions", "2. Sheets formula engine — 20 functions, cell references, cross-tab", "3. Meet recording pipeline — capture, store, transcribe"] }, notes: "We have capacity for ~2.5 of these." },
      { layout: "split", content: { layout: "split", title: "Assistant automation", left: "The assistant can already do single actions. The Q3 bet is chaining: draft a reply, attach the right Drive file, and schedule a follow-up — all in one confirmed workflow.", rightKind: "list", rightContent: ["5 chain types by Aug 15", "< 200ms overhead vs single action", "NPS > 7.5 in beta"] }, notes: "Alex has the technical spec ready." },
      { layout: "split", content: { layout: "split", title: "Sheets formula engine", left: "The parser is already 70% done. Evan's batched evaluation approach gives us < 50ms p95 on 1,000 cells with 200 formulas.", rightKind: "list", rightContent: ["20 functions in GA", "Cross-tab references", "P95 < 50ms on 1,000 cells"] }, notes: "This is the bet most ahead of plan — argue for pulling it forward." },
      { layout: "split", content: { layout: "split", title: "Meet recording pipeline", left: "Decision: ship against current storage and migrate to the new tier in Q4. We budget the migration explicitly — no more implicit Q4 work.", rightKind: "list", rightContent: ["Recording GA by Sep 10", "90%+ transcription accuracy", "Storage cost < $0.05/hr"] }, notes: "The storage decision is made. Don't reopen it." },
      { layout: "stats", content: { layout: "stats", title: "Resource allocation", subtitle: "Engineering capacity", stats: [{ value: "8 eng", label: "Assistant (6) + recording (2)", note: "Primary squad" }, { value: "4 eng", label: "Formula engine + perf", note: "Secondary squad" }, { value: "4 eng", label: "Infra, SOC 2, on-call", note: "Reliability band" }] }, notes: "This leaves one eng floating for escalations." },
      { layout: "bullets", content: { layout: "bullets", title: "Decisions needed today", items: ["Approve Q3 sequencing as proposed", "Confirm recording ships against current storage", "Approve 20% buffer on all infra estimates", "Confirm assistant chaining GA target: Aug 15"] }, notes: "We need explicit yes/no from every stakeholder in the room." },
      { layout: "title", content: { layout: "title", title: "Questions?", eyebrow: "Helix Product", subtitle: "Slide deck and planning doc in Drive > Roadmap" }, notes: "Leave 15 minutes for discussion." },
    ],
  },
  // Deck 2: Enterprise Launch (12 slides)
  {
    idx: 2,
    title: "Enterprise Launch — External Narrative",
    folderId: FOLDER.marketing,
    slides: [
      { layout: "title", content: { layout: "title", title: "Helix for Enterprise", eyebrow: "Launch", subtitle: "The connected workspace, with enterprise controls", bg: "accent" }, notes: "External-facing narrative. This is the customer story." },
      { layout: "stats", content: { layout: "stats", title: "Why now", stats: [{ value: "40%", label: "YoY usage growth at Northwind", note: "Our anchor reference account" }, { value: "8", label: "Connected surfaces", note: "Mail to Meet" }, { value: "1", label: "Workspace, not a bundle", note: "" }] }, notes: "Open with the 'why now' — growth makes the enterprise story credible." },
      { layout: "split", content: { layout: "split", title: "The problem", left: "Enterprise teams end up with a dozen disconnected tools. Each tool has its own sharing model, search, and notification system. The result is context scattered everywhere.", rightKind: "quote", rightContent: "My team uses 11 different apps to do what Helix does in one.", quoteWho: "Sandra Cho, IT Manager, Northwind" }, notes: "Use the Northwind quote — it's real and it's powerful." },
      { layout: "bullets", content: { layout: "bullets", title: "Everything connected", items: ["Mail, Calendar, Drive, Docs, Sheets, Slides, Chat, and Meet in one workspace", "A calendar invite that spawns a Meet room — automatically", "A document that lives alongside the email thread that created it", "The assistant that can act across every surface with one confirmation"] }, notes: "The 'everything connected' story is our moat." },
      { layout: "split", content: { layout: "split", title: "New: enterprise controls", left: "Helix for Enterprise adds the governance larger organizations need without changing the product teams already love.", rightKind: "list", rightContent: ["Data residency: US, EU, APAC", "Advanced audit logging: SIEM-compatible", "Centralized administration: user provisioning, org-wide settings"] }, notes: "Don't lead with the controls — lead with the product they already use." },
      { layout: "bullets", content: { layout: "bullets", title: "Data residency", items: ["Choose your region: US, EU, or APAC", "Data at rest and in transit stays within the region boundary", "Independent storage buckets per org (Enterprise Plus)", "EU Data Processing Agreement (DPA) included in Enterprise tier"] }, notes: "The EU story is a blocker for several enterprise prospects." },
      { layout: "bullets", content: { layout: "bullets", title: "Audit logging", items: ["Immutable audit log of all user actions across every surface", "SIEM-compatible event feed (Splunk, Sentinel, Datadog)", "Available via streaming API or daily export", "Configurable retention: 1 year (base), 7 years (Plus)"] }, notes: "This is the #1 blocker for IT admin approval. Lean in." },
      { layout: "bullets", content: { layout: "bullets", title: "Centralized administration", items: ["SCIM provisioning from Okta, Azure AD, or any SCIM 2.0 IdP", "SSO with SAML 2.0 (already available)", "Org-wide default settings (sharing, notifications, session duration)", "Admin analytics: active users, surface adoption, access reviews"] }, notes: "SCIM is the most-requested enterprise feature after audit logs." },
      { layout: "stats", content: { layout: "stats", title: "Proven at scale", stats: [{ value: "85", label: "Seats at Northwind", note: "82% DAU rate" }, { value: "8", label: "Surfaces in daily use", note: "Full platform adoption" }, { value: "99.9%", label: "Uptime SLA", note: "Enterprise tier" }] }, notes: "Northwind is the proof point. Reference them explicitly." },
      { layout: "split", content: { layout: "split", title: "Pricing", left: "Enterprise Base: $22/user/month (annual). Enterprise Plus: $32/user/month (annual).", rightKind: "list", rightContent: ["Minimum 25 seats", "Annual commitment, monthly billing available", "Custom pricing for 200+ seats", "30-day trial, no credit card required"] }, notes: "Don't negotiate on price in this slide — that's for the follow-up call." },
      { layout: "bullets", content: { layout: "bullets", title: "Getting started", items: ["Talk to our team for a personalized demo", "30-day pilot with your own data, no commitment", "Dedicated implementation support for pilots > 50 seats", "helix.local/enterprise — book a demo from the page"] }, notes: "CTA is 'book a demo', not 'start a trial'. We want the conversation first." },
      { layout: "title", content: { layout: "title", title: "Ready to get started?", eyebrow: "Helix for Enterprise", subtitle: "helix.local/enterprise" }, notes: "End on the CTA. Pause for questions." },
    ],
  },
  // Deck 3: Engineering All-Hands Q2 (10 slides)
  {
    idx: 3,
    title: "Engineering All-Hands — Q2 2026",
    folderId: FOLDER.engineering,
    slides: [
      { layout: "title", content: { layout: "title", title: "Engineering All-Hands", eyebrow: "Helix Engineering", subtitle: "Q2 2026 — what we built and what's next" }, notes: "" },
      { layout: "stats", content: { layout: "stats", title: "Q2 by the numbers", stats: [{ value: "22", label: "PRs merged per week (avg)", note: "Up from 18 in Q1" }, { value: "3", label: "P1/P2 incidents", note: "Down from 7 in Q1" }, { value: "68%", label: "D7 retention", note: "Up 3pp MoM" }] }, notes: "Lead with metrics that connect engineering output to user outcomes." },
      { layout: "bullets", content: { layout: "bullets", title: "What shipped: backend", items: ["Mail importer: resumable cursor (Sasha/Ben)", "Outbox worker: separate queues for mail and search indexing (Will)", "Search: FTS index audit, 40% latency reduction (Ivan)", "Assistant: action chaining beta — draft + attach (Alex)", "WebSocket: real-time thread state for mail (Alex)"] }, notes: "Thank the teams explicitly." },
      { layout: "bullets", content: { layout: "bullets", title: "What shipped: frontend & mobile", items: ["Drive: inline folder expansion (Celia)", "Calendar: free/busy attendee view (Celia + Ben)", "Sheets: formula engine GA (Evan + Celia)", "Mobile: push notification improvements (Kai)", "Design system v2 tokens: dark mode support (Sam)"] }, notes: "" },
      { layout: "split", content: { layout: "split", title: "Q2 incident review", left: "Three significant incidents in Q2. All resolved within SLA. The search outage (May 7) was the most impactful — root cause was a planner regression after the Postgres 16 upgrade.", rightKind: "list", rightContent: ["Search outage (May 7): 90 min, resolved", "Mail delays (Apr 30): 45 min, resolved", "Calendar attendee dedup (May 3): 2 hr, resolved"] }, notes: "Blameless. Celebrate the fast resolutions." },
      { layout: "bullets", content: { layout: "bullets", title: "Process improvements from Q2", items: ["Separate mail and search indexing queues — prevents class of incidents", "FTS index included in deploy checklist — prevents planner regressions", "Automated on-call rotation in PagerDuty — no more coverage gaps", "Query plan review added to architecture review checklist"] }, notes: "These are the durable changes. They make Q3 better." },
      { layout: "stats", content: { layout: "stats", title: "Team growth", stats: [{ value: "4", label: "New engineers joining in Q3", note: "Backend, infra, mobile, QA" }, { value: "9", label: "Open reqs total", note: "Hiring in progress" }, { value: "25", label: "Total engineers end of Q3", note: "Up from 18" }] }, notes: "Vera will cover the hiring detail in the all-hands." },
      { layout: "bullets", content: { layout: "bullets", title: "Q3 engineering focus", items: ["Assistant chaining to GA (Alex + team)", "Meet recording pipeline (Ben + Will)", "WebSocket horizontal scaling (Alex)", "SOC 2 audit prep (Gabriel)", "Keyboard shortcut MVP (Celia)"] }, notes: "This is the public commitment. Every team should leave knowing what they're building." },
      { layout: "split", content: { layout: "split", title: "Engineering values in Q2", left: "We made real improvements to reliability, speed, and quality this quarter. The process changes we adopted will compound.", rightKind: "quote", rightContent: "Ship real things. Own it end to end. Take care of each other.", quoteWho: "Helix Engineering Values" }, notes: "End on values — it sets the tone for Q3." },
      { layout: "title", content: { layout: "title", title: "Questions and open floor", eyebrow: "Helix Engineering", subtitle: "All decks and notes in Drive > Engineering" }, notes: "" },
    ],
  },
  // Deck 4: Drive Browser Design Review (8 slides)
  {
    idx: 4,
    title: "Drive Browser Redesign — Design Review",
    folderId: FOLDER.design,
    slides: [
      { layout: "title", content: { layout: "title", title: "Drive Browser Refresh", eyebrow: "Design Review", subtitle: "Inline expansion · clearer icons · unified detail panel" }, notes: "" },
      { layout: "bullets", content: { layout: "bullets", title: "What we're changing", items: ["Inline folder expansion (no full-page nav)", "Color-coded file type icons — docs, sheets, slides, media, PDFs distinct at a glance", "Unified detail panel: version history + sharing in one place", "Breadcrumb: collapse middle segments into '…' at 3+ levels"] }, notes: "Keep this slide factual. The details come later." },
      { layout: "split", content: { layout: "split", title: "Inline expansion", left: "Users told us navigating into a folder felt like leaving the page. Inline expansion keeps the current folder in view while revealing children.", rightKind: "quote", rightContent: "I kept losing my place whenever I opened a folder.", quoteWho: "User research participant" }, notes: "The research backs this. Quote is from a real session." },
      { layout: "split", content: { layout: "split", title: "The breadcrumb problem", left: "At 3+ folder levels, the breadcrumb overflows its container and ellipsis truncation hides the middle segments completely.", rightKind: "list", rightContent: ["Current: Home > Engineering > Backend > Q2 > Archive (overflow)", "Proposed: Home > … > Archive (collapse middle, keep first and last)", "Hover/click '…' to reveal full path"] }, notes: "Riley's suggestion from the design channel. Credit them in the crit." },
      { layout: "image", content: { layout: "image", title: "Mockup: inline expansion (before/after)", note: "Full mockups in Drive > Design > figma-export-drive-browser.zip" }, notes: "Walk through the before/after. Ask for feedback on the expand/collapse animation." },
      { layout: "image", content: { layout: "image", title: "Mockup: detail panel", note: "Version history, sharing settings, and activity feed in one panel." }, notes: "Point out the activity feed tab — this is new and needs validation." },
      { layout: "bullets", content: { layout: "bullets", title: "Open questions", items: ["Lazy vs. eager child loading: load on click or prefetch on hover?", "Large folders (1,000+ files): how do we paginate in the inline view?", "Activity feed in detail panel: should it show folder-level or file-level activity?", "Icon colors: should we use brand colors or a neutral palette?"] }, notes: "These are the questions we need to answer today." },
      { layout: "title", content: { layout: "title", title: "Feedback welcome", eyebrow: "Design Review", subtitle: "Leave comments on the mockups in Drive or post in #design" }, notes: "" },
    ],
  },
  // Deck 5: Company Offsite (8 slides)
  {
    idx: 5,
    title: "Company Offsite 2026 — Kickoff",
    folderId: FOLDER.people,
    slides: [
      { layout: "title", content: { layout: "title", title: "Helix Company Offsite", eyebrow: "2026", subtitle: "June 11–13 · The Foundry" }, notes: "Set an upbeat, welcoming tone." },
      { layout: "agenda", content: { layout: "agenda", title: "Three days", items: ["Day 1 (Jun 11) — Strategy & planning", "Day 2 (Jun 12) — Workshops & deep dives", "Day 3 (Jun 13) — Retrospective & social"] }, notes: "" },
      { layout: "bullets", content: { layout: "bullets", title: "Day 1: Strategy", items: ["09:00 — Welcome and housekeeping", "09:30 — Company state of the union", "10:00 — Q3 roadmap presentation and debate", "12:00 — Lunch", "13:30 — Surface breakouts (each team presents Q3 goals)", "16:00 — Open time and 1:1s", "18:30 — Team dinner at The Collective"] }, notes: "The roadmap debate is the centerpiece of Day 1." },
      { layout: "bullets", content: { layout: "bullets", title: "Day 2: Workshops", items: ["09:00 — Workshop 1: building better customer empathy (Fiona)", "11:00 — Workshop 2: scaling the team (Vera)", "13:00 — Lunch", "14:00 — Workshop 3: open topic (voted on by team)", "16:30 — Free time"] }, notes: "Workshop 3 topic will be voted on in the #offsite Slack channel before June 5." },
      { layout: "bullets", content: { layout: "bullets", title: "Day 3: Retro & social", items: ["09:00 — Annual retrospective: keep / drop / start", "11:00 — Hallway track and open space", "12:00 — Lunch and departures", "14:00 — Optional city walking tour"] }, notes: "The retro format is Start / Stop / Continue. Fiona facilitating." },
      { layout: "split", content: { layout: "split", title: "Logistics", left: "The Foundry is downtown and walkable. Book travel to arrive by 8:30am on June 11. Expense all travel through the portal.", rightKind: "list", rightContent: ["Book travel by June 1 for best rates", "Dietary needs: add to the offsite sheet", "Hotel: reserved block at The Foundry Hotel", "Remote attendance: Meet room available for all sessions"] }, notes: "The hotel block expires June 5." },
      { layout: "stats", content: { layout: "stats", title: "By the numbers", stats: [{ value: "25", label: "Team members attending", note: "" }, { value: "3", label: "Workshop facilitators", note: "" }, { value: "1", label: "Team dinner venue", note: "The Collective" }] }, notes: "" },
      { layout: "title", content: { layout: "title", title: "See you in June!", eyebrow: "Helix Company Offsite 2026", subtitle: "Questions? Post in #offsite" }, notes: "" },
    ],
  },
  // Deck 6: New Hire Orientation (9 slides)
  {
    idx: 6,
    title: "New Hire Orientation",
    folderId: FOLDER.onboarding,
    slides: [
      { layout: "title", content: { layout: "title", title: "Welcome to Helix", eyebrow: "Orientation", subtitle: "We're really glad you're here" }, notes: "" },
      { layout: "bullets", content: { layout: "bullets", title: "Today's agenda", items: ["Who we are and what we build", "How we work (async, remote, values)", "The product tour", "Your first week", "Q&A"] }, notes: "" },
      { layout: "split", content: { layout: "split", title: "Our mission", left: "We build the workspace where great teams do their best work.", rightKind: "list", rightContent: ["Founded 2022", "34 team members", "Remote-first across 8 time zones", "Customers on 4 continents"] }, notes: "Keep it short — they'll learn the detail over the first month." },
      { layout: "bullets", content: { layout: "bullets", title: "The product", items: ["Mail — the best mail client you've used", "Calendar — events connected to Meet rooms automatically", "Drive — files that live alongside the conversations about them", "Docs, Sheets, Slides — editing that works in real time", "Chat — fast, searchable, connected to everything else", "Meet — video calls with automatic summaries and recording", "Assistant — an agent that acts across every surface"] }, notes: "Demo this, don't just read it." },
      { layout: "bullets", content: { layout: "bullets", title: "How we work", items: ["Async by default — write things down, don't rely on meetings", "Meetings have agendas — no agenda, no meeting", "Bias for action — ship a small version and learn", "Default to open — transparency is a feature, not a perk", "Feedback is a gift — give it directly and early"] }, notes: "These are the values in practice. Ask them what stood out." },
      { layout: "agenda", content: { layout: "agenda", title: "Your first week", items: ["Day 1: setup, buddy, welcome lunch", "Day 2–3: codebase tour, shadow on-call, first PR", "Week 1: ship one small thing end-to-end", "Book a 1:1 with your manager by Day 3"] }, notes: "" },
      { layout: "bullets", content: { layout: "bullets", title: "Who to ask", items: ["Engineering questions → Hannah Price (EM) or your buddy", "Product questions → Diana Singh", "HR and benefits → Vera Stone", "IT and access → it@helix.local", "Everything else → #general in Chat"] }, notes: "Emphasize the buddy — they're the most important resource in week one." },
      { layout: "stats", content: { layout: "stats", title: "You're in good company", stats: [{ value: "68%", label: "D7 user retention", note: "People love the product" }, { value: "4.8", label: "Glassdoor rating", note: "Team loves working here" }, { value: "48", label: "Enterprise NPS", note: "Customers love us" }] }, notes: "" },
      { layout: "title", content: { layout: "title", title: "Questions?", eyebrow: "Welcome to Helix", subtitle: "Handbook and resources in Drive > Helix Workspace" }, notes: "" },
    ],
  },
  // Deck 7: SOC 2 Prep Overview (8 slides)
  {
    idx: 7,
    title: "SOC 2 Audit Preparation Overview",
    folderId: FOLDER.security,
    slides: [
      { layout: "title", content: { layout: "title", title: "SOC 2 Type II Audit Preparation", eyebrow: "Helix Security", subtitle: "Target audit window: Q4 2026" }, notes: "" },
      { layout: "agenda", content: { layout: "agenda", title: "Agenda", items: ["What is SOC 2 and why we're doing it", "Trust service criteria scope", "Gap assessment summary", "Evidence collection plan", "Timeline and owners"] }, notes: "" },
      { layout: "split", content: { layout: "split", title: "Why SOC 2 now", left: "SOC 2 Type II is the top audit requirement for enterprise deals > 50 seats. The Northwind renewal and 6 other pipeline deals are contingent on it.", rightKind: "list", rightContent: ["Required for enterprise tier GA", "Northwind renewal blocked without it", "6 pipeline deals worth $1.2M ARR", "Target completion: Q4 2026"] }, notes: "This is a revenue initiative, not just a compliance checkbox." },
      { layout: "bullets", content: { layout: "bullets", title: "Trust service criteria: scope", items: ["Security (required)", "Availability (in scope — enterprise SLA)", "Confidentiality (in scope — data residency commitment)", "Processing integrity (out of scope for this audit)", "Privacy (out of scope for this audit)"] }, notes: "Keeping privacy and processing integrity out of scope keeps the audit manageable." },
      { layout: "stats", content: { layout: "stats", title: "Gap assessment summary", stats: [{ value: "48", label: "Controls assessed", note: "" }, { value: "38", label: "Controls passing", note: "79%" }, { value: "10", label: "Controls requiring remediation", note: "21%" }] }, notes: "The 10 gaps are documented in the gap tracker sheet." },
      { layout: "bullets", content: { layout: "bullets", title: "Key remediation items", items: ["Access review process: document and execute quarterly (Gabriel, due Jun 30)", "Vulnerability management policy: formal SLA for CVE response (Gabriel, due Jun 15)", "Incident response runbook: complete and tested (Will + Omar, due Jul 15)", "Change management documentation: PR → deploy audit trail (Will, due Jun 30)", "Vendor risk assessments: CloudSupplier and Postmark (Lena, due Jul 31)"] }, notes: "All five are owned. Gabriel is coordinating." },
      { layout: "bullets", content: { layout: "bullets", title: "Timeline", items: ["May–Jun: remediation (10 control gaps)", "Jul–Aug: evidence collection (12 weeks continuous)", "Sep: readiness assessment with auditors", "Oct: SOC 2 audit begins", "Dec: report issued"] }, notes: "The Oct start date is firm — it's contractually committed to Northwind." },
      { layout: "title", content: { layout: "title", title: "Questions?", eyebrow: "SOC 2 Prep", subtitle: "Gap tracker and evidence list in Drive > Security" }, notes: "" },
    ],
  },
  // Deck 8: UX Research Readout (9 slides)
  {
    idx: 8,
    title: "UX Research Readout — Enterprise Pilot",
    folderId: FOLDER.ux,
    slides: [
      { layout: "title", content: { layout: "title", title: "Enterprise Pilot UX Research", eyebrow: "Helix UX Research", subtitle: "12 sessions · 3 accounts · April 2026" }, notes: "" },
      { layout: "stats", content: { layout: "stats", title: "Study overview", stats: [{ value: "12", label: "Moderated sessions", note: "" }, { value: "3", label: "Enterprise accounts", note: "Northwind, Acme, Orion" }, { value: "60", label: "Minutes per session", note: "" }] }, notes: "" },
      { layout: "bullets", content: { layout: "bullets", title: "Key finding 1: Mail → Calendar is the hero", items: ["8 of 12 participants mentioned the mail-to-event flow unprompted", "Most-cited feature they'd miss if it disappeared", "Quote: 'I used to have to manually create the invite every time. Now it just... happens.'", "This is the activation moment — we should highlight it in onboarding"] }, notes: "This is the most action-able finding for the product team." },
      { layout: "split", content: { layout: "split", title: "Key finding 2: Permission wording confuses new users", left: "New users consistently misread 'can comment' as 'can edit'. The distinction between view, comment, and edit was not intuitive.", rightKind: "quote", rightContent: "I thought 'comment' meant they could change things. I was nervous to share.", quoteWho: "Research participant, Acme Corp" }, notes: "Sam has mockups for the revised wording. This should ship before enterprise GA." },
      { layout: "bullets", content: { layout: "bullets", title: "Key finding 3: IT admins need audit logs for procurement approval", items: ["All 3 IT admins cited audit log export as a hard requirement", "Two have existing SIEM workflows they need to connect Helix to", "Quote: 'This is on our security checklist. If it's not there, it's a no.'", "This is the single biggest unlocker for enterprise expansion"] }, notes: "This was already known but the research confirms it's a hard blocker, not a nice-to-have." },
      { layout: "bullets", content: { layout: "bullets", title: "Key finding 4: Assistant trust builds faster than expected", items: ["Participants started using the assistant for non-trivial tasks within the first session", "Confirmation gating was cited as the key trust mechanism", "Quote: 'The fact that it asks before doing things made me feel safe experimenting.'", "Implication: don't reduce confirmation gating to reduce friction"] }, notes: "Counter-intuitive. The friction is a feature for trust-building." },
      { layout: "split", content: { layout: "split", title: "Recommended actions", left: "Three actions came out of this research. All three are already in the Q3 plan — the research confirms priority.", rightKind: "list", rightContent: ["HIGH: Share dialog rewording (design done, Sam owns)", "HIGH: Audit log export for IT admins (Gabriel, Q3 target)", "MEDIUM: Reduce clicks from mail thread to calendar event"] }, notes: "These are prioritized. Don't add more out of this session." },
      { layout: "stats", content: { layout: "stats", title: "Quotes that stuck", stats: [{ value: "8/12", label: "Cited mail-to-calendar as top feature", note: "" }, { value: "3/3", label: "IT admins blocked on audit logs", note: "" }, { value: "9/12", label: "Assistant trust faster than expected", note: "" }] }, notes: "" },
      { layout: "title", content: { layout: "title", title: "Full report and recordings", eyebrow: "Enterprise Pilot Research", subtitle: "Drive > Research > Enterprise Pilot" }, notes: "" },
    ],
  },
  // Deck 9: Data & Analytics Review (8 slides)
  {
    idx: 9,
    title: "Analytics Monthly Review — April 2026",
    folderId: FOLDER.data,
    slides: [
      { layout: "title", content: { layout: "title", title: "Analytics Monthly Review", eyebrow: "April 2026", subtitle: "Key metrics, trends, and action items" }, notes: "" },
      { layout: "stats", content: { layout: "stats", title: "April headlines", stats: [{ value: "12%", label: "DAU growth MoM", note: "Best month ever" }, { value: "41%", label: "Multi-surface activation", note: "Up from 35% in March" }, { value: "39%", label: "Assistant confirmed actions growth", note: "Draft + attach is the top chain" }] }, notes: "Lead with the headline numbers. These are all records." },
      { layout: "split", content: { layout: "split", title: "Sheets DAU spike (+42%)", left: "Sheets DAU grew 42% in April, driven by the formula engine beta opening to all paid plans on April 7.", rightKind: "list", rightContent: ["42% MoM growth after formula engine GA", "20% of new Sheets users created a formula in their first session", "NPS for Sheets among formula users: 8.1 (up from 6.4)"] }, notes: "This is the best argument for pulling the formula engine to Q3 GA faster." },
      { layout: "bullets", content: { layout: "bullets", title: "Activation: what's working", items: ["Multi-surface activation at 41% — up 6pp MoM (target: 45% by Q3)", "Mail → Calendar handoff is the #1 activation trigger (confirmed by research)", "New onboarding checklist (shipped Mar 31) is improving D7 retention", "The assistant walkthrough in onboarding is reducing time to first assistant action by 40%"] }, notes: "The onboarding work is paying off faster than projected." },
      { layout: "bullets", content: { layout: "bullets", title: "Where we're losing users", items: ["D30 retention at 52% — target is 60% by Q3. Primary drop-off: week 2", "Week 2 drop-off correlates with 'gets stuck on sharing permissions' support tickets", "Meet adoption is growing slowest (6% MoM). Audio quality complaints are a factor", "Slides is under-discovered — most users never open it without a prompt"] }, notes: "The sharing permissions connection is from research. Ship the rewording fast." },
      { layout: "stats", content: { layout: "stats", title: "Enterprise segment", stats: [{ value: "8", label: "Active enterprise accounts", note: "" }, { value: "82%", label: "Northwind DAU rate", note: "Best in segment" }, { value: "1.8%", label: "Enterprise churn rate", note: "Down from 2.1% in Q1" }] }, notes: "" },
      { layout: "bullets", content: { layout: "bullets", title: "May priorities (from this data)", items: ["Ship sharing dialog rewording — the data confirms it's causing D30 drop-off", "Instrument the Meet audio quality issue — do we know the root cause?", "Investigate Slides discovery — is the navigation hiding it?", "Set up a cohort for users who activate on the mail-to-calendar flow"] }, notes: "These are data-driven recommendations, not guesses." },
      { layout: "title", content: { layout: "title", title: "Full data in Metabase", eyebrow: "Helix Analytics", subtitle: "April dashboard and raw data in Drive > Data" }, notes: "" },
    ],
  },
  // Deck 10: Infra Roadmap (8 slides)
  {
    idx: 10,
    title: "Infrastructure Roadmap — H2 2026",
    folderId: FOLDER.infra,
    slides: [
      { layout: "title", content: { layout: "title", title: "Infrastructure Roadmap", eyebrow: "H2 2026", subtitle: "Scaling for enterprise, reliability for everyone" }, notes: "" },
      { layout: "stats", content: { layout: "stats", title: "Current state", stats: [{ value: "500", label: "Concurrent WS connections (capacity)", note: "Current ceiling" }, { value: "46.8k", label: "Monthly infra cost", note: "Up 3%/mo trend" }, { value: "99.94%", label: "Q2 availability", note: "Target: 99.9%" }] }, notes: "We're above availability target but WS capacity is the constraint." },
      { layout: "bullets", content: { layout: "bullets", title: "H2 priorities", items: ["1. Enterprise storage tier — dedicated S3 buckets per org (Omar, Aug 20)", "2. Second read replica for the enterprise tier (Omar, Jul 30)", "3. WebSocket horizontal scaling — remove the 500-connection ceiling (Alex, Sep 15)", "4. Kinesis event pipeline for data warehouse feed (Will, Aug 15)", "5. Automated certificate rotation (Will, Jul 30)"] }, notes: "These are the five items. Sequence matters — storage and replica before scaling." },
      { layout: "split", content: { layout: "split", title: "Enterprise storage tier", left: "Dedicated S3 buckets per org give us a clean data residency story (EU, US, APAC) and a path to GDPR Article 17 erasure without bulk-deleting from a shared bucket.", rightKind: "list", rightContent: ["Bucket per org, region-selectable", "Encryption key per org (for Enterprise Plus)", "Lifecycle policies per org", "Cost impact: +$3,500/mo at current scale"] }, notes: "This unlocks the data residency enterprise feature. Required for the launch." },
      { layout: "split", content: { layout: "split", title: "WebSocket scaling", left: "Today we run one API server with a 500-connection ceiling. At 20% MoM DAU growth, we hit the ceiling in approximately 4 months.", rightKind: "list", rightContent: ["Move WS fan-out to Redis pub/sub (RESP3)", "Any API node can serve any client", "Load test target: 5,000 concurrent connections per node", "Expected: 10x capacity increase with linear cost scaling"] }, notes: "Alex has the design doc. Architecture review scheduled for next week." },
      { layout: "bullets", content: { layout: "bullets", title: "Cost forecast", items: ["Base trajectory: $46.8k/mo → $58k/mo by Q4 (organic growth)", "Enterprise tier additions: +$3.5k/mo per 100 enterprise seats", "WS scaling: +$1.8k/mo fixed (Redis) + linear with connections", "Kinesis pipeline: +$1.2k/mo fixed at current event volume"] }, notes: "The CFO will ask for a cost per-seat model. Evan has that." },
      { layout: "bullets", content: { layout: "bullets", title: "Risk register", items: ["HIGH: WS capacity ceiling before scaling work is done — mitigation: monitor closely, alert at 400 connections", "MEDIUM: Storage migration timeline slipping due to org-bucket mapping complexity — mitigiation: time-box design to 2 sprints", "LOW: Kinesis cost overrun if event volume spikes — mitigation: sampling rate limiter at 10k events/sec"] }, notes: "" },
      { layout: "title", content: { layout: "title", title: "Questions?", eyebrow: "Infra Roadmap H2 2026", subtitle: "Full specs in Drive > Engineering > Infrastructure" }, notes: "" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedSlides(sql: SeedSql, orgId: string): Promise<{ decks: number; slides: number }> {
  let slideCount = 0;

  for (const deck of DECKS) {
    const deckId = uid("f500", deck.idx);
    await sql`
      insert into slide_decks (id, org_id, title, owner_actor_id, created_by_actor_id, metadata)
      values (${deckId}, ${orgId}, ${deck.title}, ${ADMIN_ACTOR}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict (id) do update set title = excluded.title, metadata = excluded.metadata, updated_at = now()
    `;
    // Shared-PK objects row.
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${deckId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`slides/${orgId}/${deckId}`},
        'application/vnd.helix.presentation', 0, null,
        ${json(sql, {
          source: WORKSPACE_SEED_LARGE_SOURCE,
          app: "slides",
          name: deck.title,
          title: deck.title,
          folderId: deck.folderId,
        })}
      )
      on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
    `;

    for (const [pi, slide] of deck.slides.entries()) {
      await sql`
        insert into slides (id, org_id, deck_id, position, layout, content, speaker_notes)
        values (
          ${uid("f600", deck.idx * 30 + pi)}, ${orgId}, ${deckId}, ${pi},
          ${slide.layout}, ${json(sql, slide.content as postgres.JSONValue)}, ${slide.notes}
        )
        on conflict (id) do update
        set layout = excluded.layout, content = excluded.content, speaker_notes = excluded.speaker_notes, updated_at = now()
      `;
      slideCount++;
    }
    await grantBoth(sql, orgId, "slide_deck", deckId, "owner");
  }

  return { decks: DECKS.length, slides: slideCount };
}

// We need to import postgres for the JSONValue type cast
import type postgres from "postgres";
