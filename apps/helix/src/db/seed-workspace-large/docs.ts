/**
 * Seed ~80 documents with real multi-section markdown content.
 *
 * Threads:   e000 group
 * Documents: e100 group
 * Updates:   e200 group
 * Comments:  e300 group
 */

import { buildDocsBodyState } from "../seed-docs-body.js";
import {
  ADMIN_ACTOR,
  FOLDER,
  WORKSPACE_SEED_LARGE_SOURCE,
  daysFromNow,
  grantBoth,
  json,
  teamId,
  uid,
  type SeedSql,
} from "./config.js";

interface DocDef {
  readonly idx: number;
  readonly title: string;
  readonly folderId: string;
  readonly tags: readonly string[];
  readonly markdown: string;
  readonly versions?: number;
  readonly comments?: readonly { readonly actorIdx: number; readonly body: string; readonly resolved?: boolean }[];
}

// ---------------------------------------------------------------------------
// Document content
// ---------------------------------------------------------------------------

const DOCS: readonly DocDef[] = [
  // --- Engineering docs (idx 1-25) ---
  {
    idx: 1,
    title: "Engineering Onboarding Guide",
    folderId: FOLDER.backend,
    tags: ["engineering","onboarding"],
    versions: 2,
    markdown: `# Engineering Onboarding Guide

## Welcome

You've joined one of the best engineering teams around. This guide will get you from zero to productive in your first week.

## Day 1: Environment setup

- Clone the helix/platform monorepo from GitHub
- Run \`pnpm install\` at the root to install all dependencies
- Copy \`.env.example\` to \`.env.local\` and fill in local credentials
- Start the dev stack with \`pnpm dev\` — Postgres, Redis, and the API server will start via Docker Compose
- Verify the API is running at http://localhost:3000/healthz

## Day 2–3: Codebase tour

- Read the Architecture Overview doc in the Engineering folder
- Trace a mail send from the SMTP server through ingest → store → outbox
- Shadow an on-call shift to see the monitoring stack live
- Ask your buddy to walk you through the permissions model

## Week 1: First contribution

- Pick up a "good first issue" from the engineering backlog
- Follow the PR template — tests required for all changes
- Ship it

## Useful commands

\`\`\`
pnpm typecheck       # run TypeScript compiler, zero errors required
pnpm lint            # ESLint, zero warnings required
pnpm test            # Vitest unit tests
pnpm db:migrate      # run pending migrations
pnpm db:seed:logins  # seed the two login accounts
\`\`\`
`,
    comments: [
      { actorIdx: 8, body: "Welcome! The buddy assignment is in your onboarding ticket." },
      { actorIdx: 1, body: "Added the db:seed commands — new folks always ask about those.", resolved: true },
    ],
  },
  {
    idx: 2,
    title: "Architecture Overview — v2",
    folderId: FOLDER.backend,
    tags: ["engineering","architecture"],
    versions: 3,
    markdown: `# Architecture Overview — v2

## Shape

Helix is a modular monolith. Each surface — Mail, Drive, Docs, Calendar, Chat, Sheets, Slides, Meet — is a platform module with its own \`store.ts\`, \`tools.ts\`, and \`routes.ts\`, all sharing one Postgres database and one S3-compatible object store.

## Request flow

1. Browser → Fastify HTTP/WS server
2. Fastify → platform routes → surface store
3. Store → Postgres (via \`postgres\` driver)
4. Side effects (webhooks, indexing, notifications) → transactional outbox worker

## Core tables

| Table | Purpose |
| --- | --- |
| \`actors\` | Users, agents, service accounts |
| \`threads\` | Mail conversations, chat rooms, docs, cal events, calls |
| \`messages\` | All messages: mail, chat, system |
| \`objects\` | Drive files, attachments, recordings |
| \`permissions\` | \`(resource_type, resource_id, actor_id, role)\` |

## Permissions model

Authorization is a single \`permissions\` table. Every read path joins against it. There is no implicit access — not even for the actor who created a resource.

## Assistant

The assistant calls platform tools through a strongly-typed registry. Each tool declares its name, input schema, required scopes, and whether it needs confirmation. The registry enforces all three before execution.

## Scaling notes

The current setup handles ~500 concurrent WebSocket connections comfortably on a single instance. Horizontal scaling is unblocked once the outbox worker is made distributed — tracked in the infra backlog.
`,
  },
  {
    idx: 3,
    title: "API Design Guidelines",
    folderId: FOLDER.backend,
    tags: ["engineering","api"],
    markdown: `# API Design Guidelines

## Versioning

We version the HTTP API in the path: \`/api/v1/...\`. Breaking changes require a new version.

## Naming

- Resources are plural nouns: \`/threads\`, \`/objects\`, \`/events\`
- Actions that are not CRUD use verb-noun: \`/messages/{id}/reactions\`
- Timestamps are ISO 8601 UTC strings

## Response shape

All successful responses return JSON. Errors follow the RFC 7807 problem format:

\`\`\`json
{
  "type": "https://helix.local/errors/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "Thread abc123 not found"
}
\`\`\`

## Pagination

Cursor-based pagination everywhere. Request \`cursor\` and \`limit\`; response includes \`nextCursor\` (null when exhausted).

## Authentication

Every request carries a session cookie or Bearer token. The Fastify middleware validates it before the route handler runs.
`,
  },
  {
    idx: 4,
    title: "Database Conventions",
    folderId: FOLDER.backend,
    tags: ["engineering","database"],
    markdown: `# Database Conventions

## Identifiers

All primary keys are UUIDs (v4). We do not use sequential integers for application IDs — they leak counts and create migration headaches.

## Timestamps

Every table has \`created_at\` and \`updated_at\` with timezone. The application sets \`updated_at\` on every update; a trigger is the fallback.

## JSON columns

Use \`jsonb\` for semi-structured data. Index frequently queried keys with partial indexes.

## Migrations

Migrations live in \`src/db/migrations/\`. Every migration must be:
- Idempotent (\`if not exists\`, \`on conflict do nothing\`)
- Non-destructive in the forward direction
- Accompanied by a rollback SQL file

## Indexes

Always add an index when adding a foreign key. Query plans are reviewed in the architecture review; table scans in hot paths are a blocker.
`,
  },
  {
    idx: 5,
    title: "On-call Runbook — v2",
    folderId: FOLDER.infra,
    tags: ["engineering","operations"],
    markdown: `# On-call Runbook — v2

## Escalation path

1. **L1 — On-call engineer**: acknowledge and triage within 5 minutes
2. **L2 — Engineering lead (Hannah)**: escalate after 30 minutes of no progress
3. **L3 — Principal (Ulrich)**: escalate for P1 incidents affecting >10% of users

## Dashboards

- **Overview**: http://grafana.internal/d/helix-overview
- **Mail**: http://grafana.internal/d/helix-mail
- **Database**: http://grafana.internal/d/helix-postgres

## Common playbooks

### Mail delivery queue backing up
1. Check \`select count(*) from outbox where status = 'pending'\`
2. If count > 1000, restart the outbox worker
3. If count growing faster than clearing, page L2

### Drive upload failures
Check the object storage endpoint. \`curl -I https://storage.helix.local/healthz\`

### High database CPU
Run \`select * from pg_stat_activity where state = 'active'\` and look for long-running queries.

## Post-incident

Write a short blameless postmortem within 48 hours. Template in the Legal & Compliance folder.
`,
    comments: [
      { actorIdx: 9, body: "Added the Grafana dashboard links — they were in Slack but not here." },
    ],
  },
  {
    idx: 6,
    title: "Security Guidelines for Engineers",
    folderId: FOLDER.security,
    tags: ["engineering","security"],
    markdown: `# Security Guidelines for Engineers

## Secrets management

- Never commit secrets to git, even in private repos
- All secrets live in the secrets manager; the app reads them at startup from environment variables
- Rotate secrets quarterly or immediately on suspected exposure

## Input validation

- Validate all inputs at the API boundary with Zod
- SQL queries go through the \`postgres\` tagged-template driver — no string interpolation
- File uploads are type-checked and size-limited before hitting object storage

## Authentication

- Session cookies are \`HttpOnly\`, \`Secure\`, \`SameSite=Lax\`
- API tokens expire after 90 days; service account tokens rotate automatically
- MFA is required for all accounts with admin scopes

## Dependency hygiene

- Dependabot PRs are reviewed weekly
- Critical CVEs are patched within 24 hours; high within 7 days

## Incident response

Report suspected security incidents to \`security@helix.local\` immediately. Do not discuss in public channels before the incident is contained.
`,
  },
  {
    idx: 7,
    title: "Frontend Architecture",
    folderId: FOLDER.frontend,
    tags: ["engineering","frontend"],
    markdown: `# Frontend Architecture

## Stack

React 19 + TypeScript. State management per-surface via Zustand stores. Data fetching via tRPC client with optimistic updates.

## Structure

\`apps/web/src/features/\` — one sub-directory per surface (mail, drive, docs, calendar, chat, sheets, slides, meet, assistant).

Each feature exports:
- \`store.ts\` — Zustand store + async actions
- \`api.ts\` — tRPC calls (thin wrapper)
- Feature-specific components (not re-exported globally)

## Design system

Shared UI components live in \`packages/ui/\`. Do not add surface-specific logic to shared components. Use Tailwind for styling.

## Performance targets

- First meaningful paint < 1.5s on a fast connection
- Time-to-interactive < 3s
- Lighthouse performance score > 85

## Testing

- Vitest for unit tests
- Component tests use Testing Library
- End-to-end tests live in \`apps/web/src/features/**/*.e2e.ts\`
`,
  },
  {
    idx: 8,
    title: "WebSocket Protocol Reference",
    folderId: FOLDER.backend,
    tags: ["engineering","websocket","reference"],
    markdown: `# WebSocket Protocol Reference

## Connection

Clients connect to \`wss://{host}/ws\` with a valid session cookie. The server upgrades the HTTP connection and registers the actor.

## Message envelope

Every message over the socket is a JSON object:

\`\`\`json
{
  "type": "surface:action",
  "payload": { ... },
  "seq": 42
}
\`\`\`

\`seq\` increments per-connection and is used for client-side dedup.

## Subscriptions

Clients subscribe to resources they care about:

\`\`\`json
{ "type": "subscribe", "payload": { "resource": "thread", "id": "abc123" } }
\`\`\`

The server pushes updates to all subscribers when the resource changes.

## Reconnection

Clients should reconnect with exponential backoff starting at 1s, capped at 30s. Missed events since the last seen \`seq\` are replayed on reconnect.
`,
  },
  {
    idx: 9,
    title: "Mail Architecture",
    folderId: FOLDER.backend,
    tags: ["engineering","mail"],
    versions: 2,
    markdown: `# Mail Architecture

## Inbound flow

1. SMTP server receives message on port 587
2. \`mail/ingest.ts\` parses headers and body (MIME, DKIM, SPF)
3. Thread lookup: find or create thread by subject + participants
4. Message stored; thread state updated for all recipient actors
5. Outbox entry created for downstream notifications

## Outbound flow

1. Sender creates a draft via API
2. On send, message is inserted with \`direction='outbound'\`
3. Outbox worker picks it up, calls the outbound mail provider
4. Status updated to \`sent\` on success

## Threading

Messages are grouped into threads by \`References\` and \`In-Reply-To\` headers. If neither is present, a new thread is created. Subject-matching is not used (too noisy).

## Labels

Labels are org-scoped slugs stored in \`mail_labels\`. Per-actor label assignment lives in \`mail_thread_state\`. Labels are not folders — a thread can carry multiple labels.

## Categories

Mail is categorized as \`primary\`, \`updates\`, \`promotions\`, or \`social\` by a lightweight heuristic on sender domain and headers. The assistant can re-categorize.
`,
  },
  {
    idx: 10,
    title: "Chat Architecture",
    folderId: FOLDER.backend,
    tags: ["engineering","chat"],
    markdown: `# Chat Architecture

## Rooms and DMs

Rooms (\`chat_room\`) and DMs (\`chat_dm\`) are both threads in the \`threads\` table. \`chat_room_settings\` holds display metadata. Membership is modelled as permissions (\`resource_type='thread'\`).

## Message fanout

When a message is inserted, the outbox worker notifies all room members via WebSocket. Read receipts are updated lazily when the client reports them.

## Reactions

Reactions are stored in \`chat_reactions(message_id, actor_id, emoji)\`. The frontend aggregates counts client-side from the initial load and WebSocket updates.

## Mentions

\`@username\` mentions are parsed at insert time; the mentioned actor's notification feed gets an entry via the outbox.

## Threads-in-threads

Messages can have a \`parent_message_id\` to form reply threads (optional per room). The UI shows reply count inline; opening the thread loads children.
`,
  },
  {
    idx: 11,
    title: "Observability Handbook",
    folderId: FOLDER.infra,
    tags: ["engineering","observability"],
    markdown: `# Observability Handbook

## Metrics

We use Prometheus + Grafana. Key dashboards are pinned in the #engineering chat room.

Metrics naming: \`helix_{surface}_{operation}_{unit}\`

Examples:
- \`helix_mail_ingest_duration_seconds\`
- \`helix_drive_upload_bytes_total\`
- \`helix_chat_messages_sent_total\`

## Logs

Structured JSON logs via Pino. Every log line includes \`orgId\`, \`actorId\`, and \`requestId\`.

Log levels:
- **error**: something broke and an operator should know
- **warn**: degraded but not broken
- **info**: normal operational events
- **debug**: verbose, off in production

## Traces

Distributed tracing via OpenTelemetry. Traces flow from the HTTP edge through the store layer to the database.

## Alerts

PagerDuty integration. Alert thresholds documented in \`infra/alerts/\`. All P1 alerts page immediately; P2 alerts send to Slack only.
`,
  },
  {
    idx: 12,
    title: "Deployment Guide",
    folderId: FOLDER.infra,
    tags: ["engineering","deployment"],
    markdown: `# Deployment Guide

## Environments

| Environment | URL | Branch |
| --- | --- | --- |
| Production | https://helix.local | \`main\` |
| Staging | https://staging.helix.local | \`staging\` |
| Preview | auto-generated per PR | feature branch |

## Release process

1. PR reviewed and merged to \`main\`
2. CI runs typecheck, lint, and tests
3. Docker image built and pushed to ECR
4. Deployment triggered automatically to staging
5. Smoke tests run on staging
6. Manual promotion to production via the deploy button in GitHub Actions

## Database migrations

Migrations run automatically at deploy time via the \`db:migrate\` script. They must pass in under 30 seconds (table scans are blocked).

## Rollback

Deploy the previous image tag from the GitHub Actions UI. Migrations are not automatically rolled back — co-ordinate with the DBA on any rollback that involves schema changes.

## Feature flags

Use the \`feature_flags\` table to gate unreleased features. Set flags per-org in the admin panel.
`,
  },
  {
    idx: 13,
    title: "Code Review Guide",
    folderId: FOLDER.backend,
    tags: ["engineering","process"],
    markdown: `# Code Review Guide

## Reviewer responsibilities

- Understand what the PR does before looking at the diff
- Focus on correctness, security, performance, and maintainability — in that order
- Be specific: "line 42" beats "this function"
- Distinguish blockers from suggestions (use labels: **blocking**, **nit**, **question**)

## Author responsibilities

- Keep PRs small enough to review in one sitting (< 400 lines where possible)
- Fill in the PR template fully — especially the "how to test" section
- Request re-review after addressing all blocking comments
- Don't merge with unresolved blocking comments

## What to look for

- All new code paths have tests
- New SQL queries use parameters (no string interpolation)
- No secrets or credentials
- Migrations are reversible
- New API endpoints are documented

## Speed

Aim to review within one business day. If you can't, say so in the PR.
`,
  },
  {
    idx: 14,
    title: "Feature Flag Playbook",
    folderId: FOLDER.backend,
    tags: ["engineering","process"],
    markdown: `# Feature Flag Playbook

## When to use a feature flag

- Unreleased features in shared branches (trunk-based development)
- Gradual rollouts to a subset of orgs
- Kill switches for risky features in production

## Adding a flag

1. Insert a row into \`feature_flags(org_id, flag, enabled)\` (or \`null\` org_id for global)
2. Check the flag in your code: \`featureFlags.isEnabled(orgId, 'my_flag')\`
3. Document the flag in this doc and in the PR

## Removing a flag

- Only remove a flag after it is fully rolled out **or** fully retired
- Delete the code path for the disabled branch first, then the flag row

## Current flags

| Flag | Description | Status |
| --- | --- | --- |
| \`sheets_formula_engine\` | New formula engine for Sheets | Beta: all orgs |
| \`meet_recording\` | Meet recording and transcription | Internal only |
| \`assistant_chaining\` | Multi-step assistant actions | Alpha: 5 orgs |
| \`offline_docs\` | Offline document access | Not started |
`,
  },
  {
    idx: 15,
    title: "Testing Strategy",
    folderId: FOLDER.backend,
    tags: ["engineering","testing"],
    markdown: `# Testing Strategy

## Pyramid

- **Unit tests** (80%): fast, isolated, no I/O. Cover all business logic functions.
- **Integration tests** (15%): test against a real database (local Docker). Cover store functions.
- **E2E tests** (5%): test critical user journeys from the HTTP layer down.

## Coverage targets

- Unit: 80% line coverage on store and tools files
- Integration: every public API route has at least one happy-path test
- E2E: mail send/receive, doc create/edit, file upload/download, calendar event create/attend

## Running tests

\`\`\`
pnpm test                    # all unit tests
pnpm test -- --coverage      # with coverage report
pnpm test src/platform/mail  # surface-specific
\`\`\`

## Writing a good test

- Arrange, Act, Assert — one assert per test
- No implementation details — test behaviour, not internals
- Name tests as sentences: \`it('sends mail to all thread participants')\`

## Flaky tests

Flaky tests must be fixed or deleted within 72 hours of being identified. Never commit a \`it.skip\`.
`,
  },
  // --- Product docs (idx 16-30) ---
  {
    idx: 16,
    title: "Q3 OKR Tracker",
    folderId: FOLDER.roadmap,
    tags: ["product","planning"],
    markdown: `# Q3 OKR Tracker

## Objective 1: Ship assistant automation end-to-end

**Key result 1.1**: 5 confirmed chained action types (draft + attach + schedule) available to beta users by Aug 15.
**Key result 1.2**: Confirmation gating adds < 200ms to the happy path.
**Key result 1.3**: NPS for assistant feature > 7.5 in beta cohort.

## Objective 2: Sheets formula engine in GA

**Key result 2.1**: All 20 planned functions pass the test suite by Jul 30.
**Key result 2.2**: P95 formula evaluation time < 50ms for sheets with < 1000 cells.
**Key result 2.3**: Zero data-loss incidents related to formula evaluation.

## Objective 3: Meet recording pipeline in production

**Key result 3.1**: Recording available for all paid orgs by Sep 10.
**Key result 3.2**: Transcription accuracy > 90% on English audio in internal testing.
**Key result 3.3**: Storage cost per recording-hour < $0.05.

## Status as of May 21

| OKR | Status | Notes |
| --- | --- | --- |
| 1.1 | On track | 3 of 5 action types done |
| 1.2 | On track | Current p95 is 145ms |
| 1.3 | Not started | Beta opens Jun 1 |
| 2.1 | On track | 14 of 20 functions done |
| 2.2 | At risk | Need to optimize cell eval |
| 2.3 | On track | — |
| 3.1 | On track | Pipeline in staging |
| 3.2 | At risk | Accuracy at 87% on test set |
| 3.3 | On track | $0.04 in staging tests |
`,
  },
  {
    idx: 17,
    title: "Product Principles",
    folderId: FOLDER.product,
    tags: ["product","culture"],
    markdown: `# Product Principles

## 1. Do one thing well, then connect it to everything

Each surface in Helix should be genuinely good on its own. Mail should be a great mail client. Docs should be a great document editor. But the real value is in the connections: a calendar invite that spawns a Meet room, a doc that lives alongside the email thread that created it.

## 2. The assistant is a team member, not a gimmick

The assistant can see everything a logged-in user can see, act on their behalf with confirmation, and do real multi-step work. It is not a chatbot bolted on the side.

## 3. Speed is a feature

Every interaction should feel instant. We measure p95 latency, not averages. Perceived latency matters as much as actual latency — optimistic UI is not optional.

## 4. Don't hide complexity, abstract it

Power users need access to all the controls. We hide complexity behind good defaults, not behind walls. Advanced settings exist; they are just not the first thing you see.

## 5. Earn the user's trust every time

We never take irreversible actions without confirmation. Destructive operations are always undoable or require explicit user intent. Mistakes are recoverable.
`,
  },
  {
    idx: 18,
    title: "User Research: Enterprise Pilot Findings",
    folderId: FOLDER.research,
    tags: ["research","enterprise"],
    versions: 1,
    markdown: `# User Research: Enterprise Pilot Findings

## Method

Conducted 12 moderated sessions with users at three enterprise pilot accounts (Northwind, Acme Corp, Orion Health). Each session was 60 minutes. Recordings stored in Drive > Research > Enterprise Pilot.

## Key findings

### Finding 1: Mail → Calendar handoff is the most-loved feature

Eight of twelve participants spontaneously mentioned the ability to turn a mail thread into a calendar event as the feature they would most miss if removed.

### Finding 2: Drive permission wording causes confusion at onboarding

New users consistently misread "can comment" as "can edit". The current wording distinguishes "view", "comment", and "edit" but the mental model doesn't match. Priya has mockups for a revised share dialog.

### Finding 3: IT admins want audit logs before they can approve a full rollout

All three IT admins in the study said their procurement checklist includes a SIEM-compatible audit log feed. This is the top blocker for enterprise expansion.

### Finding 4: The assistant is trusted faster than expected

Participants started using the assistant for more than search within the first session. Trust was built through the confirmation gating — seeing the assistant *ask* before acting made it feel safe.

## Recommended actions

1. **High priority**: Ship the share dialog rewording (design is done)
2. **High priority**: Audit log export for IT admins (required for enterprise GA)
3. **Medium priority**: Reduce the number of clicks to create a calendar event from a mail thread
`,
    comments: [
      { actorIdx: 4, body: "The audit log finding is landing in Q3. Lena has the compliance requirements." },
      { actorIdx: 6, body: "I've uploaded the session recordings to Drive > Research.", resolved: true },
    ],
  },
  {
    idx: 19,
    title: "Assistant Design Spec",
    folderId: FOLDER.product,
    tags: ["product","assistant","design"],
    versions: 2,
    markdown: `# Assistant Design Spec

## Vision

The assistant is a connected team member with the same visibility and action scope as the logged-in user. It can read and write across every surface, within the user's permissions, and with explicit confirmation for sensitive actions.

## Interaction model

Users invoke the assistant from any surface with \`⌘K\` or the sidebar button. The assistant understands the current context (open thread, selected file, calendar date range) without the user having to re-explain it.

## Action categories

### Read actions (no confirmation needed)
- Summarize a thread, document, or meeting
- Find files in Drive by description
- List upcoming calendar events

### Write actions (single confirmation)
- Draft a mail reply
- Create a calendar event
- Rename a file

### High-impact actions (explicit two-step confirmation)
- Send a mail
- Delete a file
- Invite external attendees to a meeting

## Chaining

The assistant can chain actions: "draft a reply, attach the Q3 Roadmap deck, and schedule a follow-up for next Tuesday." Each action in the chain shows a confirmation step the user can accept or modify.

## Error handling

If an action fails, the assistant shows the specific error and offers alternatives. It never silently swallows errors.
`,
    comments: [
      { actorIdx: 1, body: "The two-step confirmation for 'send mail' is going to slow down power users. Can we make it dismissible after the first 5 uses?" },
      { actorIdx: 4, body: "That's a good point — adding a 'I know what I'm doing' preference. Filed as a follow-up." },
    ],
  },
  {
    idx: 20,
    title: "Drive UX Redesign Brief",
    folderId: FOLDER.ux,
    tags: ["design","ux","drive"],
    markdown: `# Drive UX Redesign Brief

## Background

The current Drive file browser was designed for a flat file list. As users add more folders and the folder tree deepens, the navigation becomes awkward — especially the breadcrumb, which runs off-screen at 3+ levels.

## Goals

1. Inline folder expansion (no full-page navigation to open a folder)
2. Better breadcrumb at depth: collapse middle segments into a "…" menu
3. Color-coded file type icons — docs, sheets, slides, media, PDFs are visually distinct at a glance
4. Unified detail panel combining version history, sharing, and activity

## Non-goals

- Search (that is a separate project)
- Batch operations (deferred to Q4)

## Open questions

- Should inline expansion be lazy (load children on click) or eager (prefetch on hover)?
- How do we handle a folder with 1,000+ files in the inline view?

## Success metrics

- 20% reduction in "time to find a file" in usability testing
- Breadcrumb truncation complaints drop to zero in user research
`,
  },
  {
    idx: 21,
    title: "Content Calendar — June 2026",
    folderId: FOLDER.content,
    tags: ["marketing","content"],
    markdown: `# Content Calendar — June 2026

## Themes

June's theme is **"Work better together"** — featuring stories about how teams use Helix across surfaces in a single workflow.

## Planned content

| Date | Title | Format | Author |
| --- | --- | --- | --- |
| Jun 2 | How Northwind reduced email by 40% | Case study | Quinn Reed |
| Jun 5 | 5 assistant workflows you should try | Blog post | Jade Osei |
| Jun 9 | What's new in Helix: May 2026 | Product update | Diana Singh |
| Jun 12 | Deep dive: the Sheets formula engine | Technical blog | Evan Brooks |
| Jun 16 | Designing the new Drive browser | Design blog | Sam Walker |
| Jun 19 | From inbox to agenda in two clicks | Tip & trick | Quinn Reed |
| Jun 23 | How Orion Health uses Helix Docs for compliance | Case study | Quinn Reed |
| Jun 30 | What's next: Q3 sneak peek | Blog post | Diana Singh |

## Distribution

Blog posts publish to the Helix blog and are cross-posted to LinkedIn and the beta community. Case studies are also sent to the email newsletter list (8,400 subscribers).

## Review process

Author → peer review → Jade OKs tone and voice → publish. Draft deadline is 5 days before publish date.
`,
  },
  {
    idx: 22,
    title: "Customer Journey Map",
    folderId: FOLDER.research,
    tags: ["research","customers"],
    markdown: `# Customer Journey Map

## Stages

### 1. Awareness
Customer sees a blog post, a mention on LinkedIn, or a referral from a colleague.

Key emotion: **curious**

### 2. Trial
Customer signs up for a 14-day trial. They connect mail, create their first doc, and invite a colleague.

Key emotion: **cautious optimism**
Main obstacle: Drive permission wording confusion.

### 3. Activation
Customer uses three or more surfaces in a single week — the "aha moment" where they see how the surfaces connect.

Key emotion: **delight**
Activation trigger: calendar event linked to a Meet room + doc.

### 4. Retention
Customer's team is onboarded and using Helix daily. They've built workflows in the assistant.

Key emotion: **committed**
Risk: IT admin approval is stuck on audit log requirements.

### 5. Expansion
Customer adds seats or upgrades to enterprise tier.

Key emotion: **confident**
`,
  },
  {
    idx: 23,
    title: "Competitive Analysis — Q2 2026",
    folderId: FOLDER.research,
    tags: ["research","strategy"],
    markdown: `# Competitive Analysis — Q2 2026

## Landscape

The connected workspace space has three dominant players and several challengers.

## Competitors

### Workspace A
**Strengths**: massive install base, deep integrations. **Weaknesses**: fragmented experience, each surface feels like a separate product. **Threat level**: High (market position).

### Workspace B
**Strengths**: excellent mobile apps, consumer design sensibility. **Weaknesses**: weak permissions model, no serious enterprise controls. **Threat level**: Medium (targets SMB, not enterprise).

### Workspace C
**Strengths**: AI-first marketing, strong brand. **Weaknesses**: assistant is a chatbot, not an integrated agent. Performance lags Helix on heavy documents. **Threat level**: Medium (most similar to our positioning).

## Our differentiation

1. **Unified thread model**: every item — mail, doc, event, recording — is a thread with a consistent permissions model. This is architecturally hard to copy.
2. **Integrated assistant**: the assistant is an actor in the same permission system as users, not a bolt-on.
3. **Helix is fast**: we measure and publish p95 latency. Competitors don't.

## Watch list

- Workspace C is hiring aggressively for ML. Watch their assistant roadmap.
- Workspace A acquired a meet competitor last quarter. Watch for deeper integration.
`,
  },
  {
    idx: 24,
    title: "Pricing Strategy — Enterprise Tier",
    folderId: FOLDER.product,
    tags: ["product","pricing","enterprise"],
    markdown: `# Pricing Strategy — Enterprise Tier

## Current pricing

| Tier | Price | Users |
| --- | --- | --- |
| Starter | Free | Up to 5 |
| Team | $12/user/month | Unlimited |
| Enterprise | Custom | 50+ |

## Enterprise value drivers

- Data residency options (EU, US, APAC)
- Advanced audit logging (SIEM export)
- Centralized administration
- Dedicated SLA (99.9% uptime)
- Custom integrations

## Proposed packaging

**Enterprise Base**: $22/user/month (annual) — everything in Team plus audit logs and admin panel.
**Enterprise Plus**: $32/user/month (annual) — adds data residency, custom SLA, and dedicated CS.

## Rationale

Northwind's renewal conversation showed they'd pay up to $25/user for audit logs alone. The base tier is priced to capture that willingness-to-pay while leaving room for the Plus tier's data residency premium.

## Open questions

- How do we handle seats that only use one surface (e.g., a CSM who only uses CRM integrations)?
- Is the 50-user floor for Enterprise too high? Some targets have 20–30 seats.
`,
    comments: [
      { actorIdx: 5, body: "The 50-user floor is too high based on the pipeline data — suggest 25." },
    ],
  },
  {
    idx: 25,
    title: "Sheets Formula Engine Spec",
    folderId: FOLDER.product,
    tags: ["product","sheets"],
    versions: 1,
    markdown: `# Sheets Formula Engine Spec

## Scope

The formula engine for the private beta covers:
- Arithmetic: \`+\`, \`-\`, \`*\`, \`/\`, \`^\`
- Cell references: \`A1\`, \`A1:B3\`
- 20 functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND, OR, NOT, CONCATENATE, TEXT, LEN, LEFT, RIGHT, MID, TRIM, ROUND, ABS, SQRT

## Architecture

The parser is implemented as a Pratt parser over a token stream. AST nodes are evaluated recursively. Circular references are detected at parse time.

## Cell evaluation order

Cells are evaluated in topological order (dependencies first). If a cycle is detected, all cells in the cycle show \`#CIRC\`.

## Error types

| Error | Meaning |
| --- | --- |
| \`#DIV/0\` | Division by zero |
| \`#REF\` | Invalid cell reference |
| \`#NAME\` | Unknown function name |
| \`#VALUE\` | Wrong argument type |
| \`#CIRC\` | Circular reference |

## Performance target

P95 evaluation time for a sheet with 1,000 cells and 200 formula cells: < 50ms.
`,
  },
  // --- Design docs (idx 26-35) ---
  {
    idx: 26,
    title: "Design System v2",
    folderId: FOLDER.design,
    tags: ["design","system"],
    versions: 2,
    markdown: `# Design System v2

## What's new in v2

- 4px spacing system replaced with an 8px base for larger surfaces
- New typography scale with display, heading, body, and caption tiers
- Elevation scale reduced from 6 levels to 3 (flat, raised, modal)
- Dark mode tokens added for all semantic colors

## Color tokens

| Token | Light | Dark |
| --- | --- | --- |
| \`--color-surface\` | white | #121212 |
| \`--color-on-surface\` | #1a1a1a | #e0e0e0 |
| \`--color-primary\` | #1a73e8 | #81b4f7 |
| \`--color-destructive\` | #c5221f | #f28b82 |

## Component guidelines

See the component library in Figma and the \`packages/ui/\` source.

## Migration from v1

Run \`pnpm design:migrate-tokens\` to update token references across the codebase. Manual review required for any component that overrides tokens directly.
`,
  },
  {
    idx: 27,
    title: "Accessibility Standards",
    folderId: FOLDER.design,
    tags: ["design","accessibility"],
    markdown: `# Accessibility Standards

## Target

WCAG 2.1 Level AA compliance for all user-facing surfaces.

## Requirements

- **Color contrast**: minimum 4.5:1 for body text; 3:1 for large text and UI components
- **Keyboard navigation**: all interactive elements reachable by keyboard; visible focus states required
- **Screen reader**: semantic HTML + ARIA labels where needed; no information conveyed by color alone
- **Motion**: respect \`prefers-reduced-motion\`; no animations required for core functionality

## Testing

1. Axe browser extension — run on every new component
2. Keyboard-only walkthrough — must be able to complete all core flows
3. VoiceOver (macOS) — quarterly audit of critical flows

## Known gaps

- Chat message thread reply — currently not fully keyboard navigable (tracked in #engineering)
- PDF viewer in Drive — accessibility depends on the embedded viewer
`,
  },
  {
    idx: 28,
    title: "Icon Guidelines",
    folderId: FOLDER.brand,
    tags: ["design","icons","brand"],
    markdown: `# Icon Guidelines

## Library

Helix uses a subset of Phosphor Icons (Regular weight) plus a small set of custom icons for surfaces not covered by the library.

## Usage rules

- Use the 20px size for body UI, 16px for compact/dense layouts, 24px for primary navigation
- Icons must always be accompanied by a visible label or an ARIA label (never icon-only without accessible name)
- Do not tint icons with colors that conflict with the semantic color system (e.g., don't use red for a success icon)

## Custom icons

| Name | Usage |
| --- | --- |
| \`Helix\` | Product logo mark |
| \`HelixDocs\` | Docs surface icon |
| \`HelixSheets\` | Sheets surface icon |
| \`HelixSlides\` | Slides surface icon |

## Requesting new icons

Open a Design issue with the intended usage context. The design team reviews weekly and will either find an existing match or commission a new icon.
`,
  },
  {
    idx: 29,
    title: "Motion Design Guidelines",
    folderId: FOLDER.design,
    tags: ["design","motion"],
    markdown: `# Motion Design Guidelines

## Principles

1. Motion should reinforce meaning — a list item sliding up to indicate deletion confirms what's happening.
2. Motion should not block the user — transitions should feel fast (< 200ms for most interactions).
3. Motion must respect \`prefers-reduced-motion\` — all animations degrade to instant state changes.

## Duration scale

| Duration | When to use |
| --- | --- |
| 100ms | Hover states, button feedback |
| 200ms | Expand/collapse, tooltips |
| 300ms | Panel slides, modals |
| 400ms | Full-page transitions (rare) |

## Easing

- **Ease out** (decelerate): elements entering the screen
- **Ease in** (accelerate): elements leaving the screen
- **Ease in-out**: elements that stay on screen but change state

## Do not

- Animate the same element multiple times in quick succession
- Use bounce/elastic easing in data-dense interfaces
- Add animation to a surface just because it "looks cool"
`,
  },
  {
    idx: 30,
    title: "UX Research Plan — Q3 2026",
    folderId: FOLDER.ux,
    tags: ["research","ux"],
    markdown: `# UX Research Plan — Q3 2026

## Objectives

1. Validate the assistant chaining UX before GA
2. Evaluate the Drive browser redesign with real users
3. Measure onboarding friction after the share dialog rewording ships

## Studies planned

### Study 1: Assistant chaining usability test
**Method**: Moderated think-aloud sessions (n=8)
**Participants**: Current beta users, mix of solo and team plans
**Key tasks**: Chain "draft + attach + schedule"; chain "summarize thread + reply"
**Success metric**: Task completion > 75% without assistance

### Study 2: Drive browser redesign eval
**Method**: Unmoderated usability test via UserTesting (n=20)
**Key tasks**: Navigate to a nested file; share a folder; find version history
**Success metric**: "Time to find file" < 60s for 80% of participants

### Study 3: Onboarding friction audit
**Method**: Session recordings + funnel analysis
**Key metric**: % of users who share a doc in the first 7 days

## Timeline

| Study | Start | End |
| --- | --- | --- |
| 1 | Jul 7 | Jul 18 |
| 2 | Jul 14 | Jul 25 |
| 3 | Aug 1 | Ongoing |
`,
  },
  // --- Finance docs (idx 31-38) ---
  {
    idx: 31,
    title: "Finance Onboarding Guide",
    folderId: FOLDER.finance,
    tags: ["finance","onboarding"],
    markdown: `# Finance Onboarding Guide

## Expense policy summary

- Expenses over $25 require a receipt
- Expenses over $500 require pre-approval
- Meals with clients: up to $75 per person
- Conference travel: booked through the company travel portal
- All expenses submitted via the Expense Tracker sheet by the last business day of the month

## Payroll

Payroll is processed on the 15th and last business day of every month. Direct deposit is the default. Contact \`hr@helix.local\` for changes to banking details.

## Invoices and vendor payments

All vendor invoices must be approved by the department head and submitted to \`finance@helix.local\` with a PO number. Payment terms are Net 30 by default.

## Budget questions

Each department has a Google-style OKR-aligned budget. Monthly actuals are reviewed by department leads on the 5th. Contact Evan Brooks for budget reports.
`,
  },
  {
    idx: 32,
    title: "FY2026 Budget Narrative",
    folderId: FOLDER.finance,
    tags: ["finance","planning"],
    versions: 1,
    markdown: `# FY2026 Budget Narrative

## Overview

FY2026 is a growth year. Headcount investment is front-loaded in H1 (engineering and product) to support the enterprise launch. Marketing spend ramps in H2 to drive enterprise pipeline.

## Engineering

Engineering budget grows 18% YoY, driven by four new hires (backend, infra, mobile, QA). Contractor spend decreases 40% as we replace contract capacity with FTE.

## Product & Design

Product grows by one PM (Diana's hire, Q1). Design budget is flat headcount with increased tooling spend for the new design system.

## Infrastructure

Infrastructure budget grows 28%, reflecting the move to the new storage tier and the addition of a second database replica for the enterprise tier.

## Marketing

Marketing budget grows 35% in H2, with budget allocated to:
- Enterprise content (blog, case studies, analyst briefings)
- DevConf 2026 sponsorship
- Demand generation for the enterprise tier launch

## Key assumptions

- Enterprise launch in Q3 generates a pipeline of 15+ qualified opportunities by end of Q3
- No additional office space required in FY2026 (remote-first remains default)
`,
  },
  {
    idx: 33,
    title: "Vendor Contract Register",
    folderId: FOLDER.contracts,
    tags: ["finance","legal","contracts"],
    markdown: `# Vendor Contract Register

## Active contracts

| Vendor | Category | Annual value | Renewal date | Owner |
| --- | --- | --- | --- | --- |
| CloudSupplier | Infrastructure | $180,000 | Aug 1, 2026 | Omar Hassan |
| DatadogHQ | Monitoring | $24,000 | Mar 1, 2027 | Ivan Petrov |
| GitHub | Version control | $4,800 | Dec 1, 2026 | Will Cross |
| Figma | Design tools | $6,000 | Jan 1, 2027 | Sam Walker |
| UserTesting | UX research | $12,000 | Jul 1, 2026 | Fiona Marsh |
| Lever | ATS | $8,400 | Sep 1, 2026 | Vera Stone |
| PagerDuty | On-call mgmt | $3,600 | Feb 1, 2027 | Ivan Petrov |
| Postmark | Mail delivery | $1,200 | Rolling monthly | Will Cross |

## Upcoming renewals (next 90 days)

- UserTesting — Jul 1 (Fiona: considering downgrade)
- CloudSupplier — Aug 1 (Omar: negotiate new storage tier pricing)
- Lever — Sep 1 (Vera: evaluate alternatives)
`,
  },
  {
    idx: 34,
    title: "Payroll Compliance Guide",
    folderId: FOLDER.payroll,
    tags: ["finance","compliance","hr"],
    markdown: `# Payroll Compliance Guide

## Classification

All Helix employees are W-2 (US) or equivalent in their jurisdiction. Contractors are 1099-NEC (US) or equivalent. Misclassification carries significant legal and tax risk — consult Legal before engaging anyone as a contractor.

## Pay equity review

Salary bands are reviewed annually in Q1. Any out-of-band compensation requires VP approval and is reviewed in the following equity analysis.

## Benefits

- Health insurance: medical, dental, and vision; 100% employer-paid for employee, 75% for dependents
- 401(k): 4% employer match, immediate vesting
- Equity: option grants reviewed semi-annually

## Terminations

Final pay is processed within 3 business days for voluntary terminations and immediately for involuntary in jurisdictions requiring it. Contact Legal before initiating any termination.

## GDPR and payroll data

Employee payroll data is retained for 7 years per applicable law. Access is restricted to HR, Finance, and Legal.
`,
  },
  // --- People/HR docs (idx 35-42) ---
  {
    idx: 35,
    title: "New Hire Welcome Packet",
    folderId: FOLDER.onboarding,
    tags: ["people","onboarding"],
    markdown: `# New Hire Welcome Packet

## Welcome to Helix

We're thrilled to have you on the team. This packet has everything you need for your first week.

## Before day 1

- Accept the invite to your Helix workspace
- Set up your laptop (IT will send instructions separately)
- Read the company handbook in Drive

## Day 1 schedule

- 9:00 — Meet your buddy (calendar invite to follow)
- 10:00 — IT setup and workspace tour
- 12:00 — Welcome lunch with the team
- 14:00 — HR onboarding (benefits, equity, policies)
- 16:00 — Free time to explore the product

## Who to ask for what

| Topic | Contact |
| --- | --- |
| IT & access | \`it@helix.local\` |
| Benefits & payroll | Vera Stone |
| Engineering questions | Hannah Price |
| Product questions | Diana Singh |
| General help | #general in Chat |

## The short version

We build Helix. We use Helix. The best feedback about the product comes from living in it.
`,
  },
  {
    idx: 36,
    title: "Performance Review Template",
    folderId: FOLDER.people,
    tags: ["people","hr","process"],
    markdown: `# Performance Review Template

## Self-assessment

**What did you accomplish this cycle?**
(Describe 3–5 significant contributions, with impact where possible.)

**What are you most proud of?**
(One paragraph.)

**Where did you fall short of your own expectations?**
(Be honest — this section is the most valuable for growth.)

**What do you want to work on next cycle?**
(Skills, projects, scope — be specific.)

## Peer feedback

Peer feedback is collected anonymously. Reviewees receive a synthesis, not individual responses.

## Manager evaluation

Managers rate each report on four dimensions:
1. **Impact** — quality and scale of output
2. **Scope** — complexity and independence of work
3. **Collaboration** — effective cross-functional work
4. **Growth** — learning and development trajectory

Ratings: Exceeds expectations / Meets expectations / Needs improvement.

## Calibration

Ratings are calibrated in a cross-functional manager meeting before being shared. No ratings are final until calibration is complete.
`,
  },
  {
    idx: 37,
    title: "Hiring Process Guide",
    folderId: FOLDER.hiring,
    tags: ["people","hiring","process"],
    markdown: `# Hiring Process Guide

## Stages

1. **Recruiter screen** (30 min): culture fit, logistics, comp expectations
2. **Hiring manager screen** (45 min): experience depth, motivations
3. **Technical / skills round** (60–90 min): depends on role
4. **Design exercise / take-home** (design roles only; 4 hours max)
5. **Onsite loop** (4 hours): 4 x 45-min interviews across skill areas
6. **Reference checks** (2 professional references)
7. **Offer**

## Inclusive hiring practices

- Structured interviews: all interviewers use the same question set
- Diverse panels: loops should include at least one interviewer who is not from the hiring team
- Consistent scoring: use the 1–4 rubric, not gut feel

## Debrief

Debrief within 48 hours of the onsite. Hiring decision requires consensus at debrief — one strong objection is a no. "Lean hire" from all interviewers with no strong objection is a hire.

## Offer process

Vera Stone manages all offer calls. Compensation is set by the band; out-of-band offers require VP approval and are flagged in the pay equity review.
`,
  },
  {
    idx: 38,
    title: "Remote Work Policy",
    folderId: FOLDER.people,
    tags: ["people","policy"],
    markdown: `# Remote Work Policy

## Default: remote-first

Helix is remote-first. There is no office attendance requirement. Team leads set expectations for asynchronous response times (typically same business day).

## Synchronous time

Core synchronous hours are 10:00–15:00 in the team's primary time zone. Key meetings (standups, retrospectives, planning) are scheduled in this window.

## In-person gatherings

- Annual company offsite (3 days)
- Quarterly team offsites (optional; expenses covered)
- New hire onboarding week (strongly encouraged)

## Equipment and home office

New hires receive a $1,500 equipment stipend and a $500 home office allowance. Upgrades are reviewed annually.

## Travel

Travel for customer meetings, conferences, and offsites is fully expensed. Book through the travel portal. Pre-approval required for trips over $1,500.

## Time zones

We currently operate across UTC−8 to UTC+2. Meetings should not be scheduled before 8:00 or after 18:00 in any participant's local time when possible.
`,
  },
  // --- Marketing docs (idx 39-45) ---
  {
    idx: 39,
    title: "Enterprise Launch Brief",
    folderId: FOLDER.marketing,
    tags: ["marketing","enterprise","launch"],
    markdown: `# Enterprise Launch Brief

## Launch date

Target: Q3 2026, aligned with the company offsite week.

## Narrative

Helix for Enterprise: the connected workspace teams already love, now with the controls larger organizations need.

Three new enterprise capabilities:
1. **Data residency** — choose your region (US, EU, APAC)
2. **Audit logging** — SIEM-compatible event feed
3. **Centralized administration** — org-wide settings, user provisioning

## Audience

- IT decision-makers at 50–500 seat organizations
- Technical buyers (CTO, VP Engineering) at companies already evaluating the space

## Key messages

1. One workspace, not a bundle of tools — everything is connected
2. Same fast, capable product your team already uses — now with enterprise controls
3. Built on a permissions model that actually works — no shadow IT

## Launch activities

- Press release + analyst briefings (Luna PR handling)
- Enterprise blog post series (5 posts, see Content Calendar)
- DevConf 2026 speaking slot (confirmed)
- SDR cold outreach to 200 target accounts
- Existing customer expansion playbook (Nina and Marco leading)
`,
  },
  {
    idx: 40,
    title: "Brand Voice Guide",
    folderId: FOLDER.brand,
    tags: ["marketing","brand"],
    markdown: `# Brand Voice Guide

## Voice

Helix is **calm, capable, and direct**.

We explain things plainly. We don't oversell. When in doubt, we cut a sentence.

## Tone by context

| Context | Tone | Example |
| --- | --- | --- |
| Error messages | Calm, specific, helpful | "We couldn't upload that file. Check the file size (limit 5 GB) and try again." |
| Feature announcements | Enthusiastic but grounded | "The Sheets formula engine is now available. Here's what you can do with it." |
| Security alerts | Direct, actionable | "We detected a new sign-in. If this was you, no action needed." |
| Onboarding | Warm, encouraging | "Your workspace is ready. Start with Mail or jump straight to Docs." |

## Don'ts

- Avoid exclamation marks (one per email is the max)
- Never use "seamlessly" or "powerful" — they are meaningless filler
- Don't say "world-class" or "best-in-class"
- Avoid passive voice in instructions

## Writing checklist

Before publishing, read the copy aloud. If it sounds like a brochure, rewrite it.
`,
  },
  {
    idx: 41,
    title: "Blog Post: Sheets Formula Engine",
    folderId: FOLDER.content,
    tags: ["marketing","content","sheets"],
    markdown: `# Blog Post: The Helix Sheets Formula Engine

*Author: Evan Brooks | Planned: June 12*

---

## Draft

We built a formula engine for Helix Sheets from scratch. Here's what we built, why, and what it can do now.

### Why from scratch?

Spreadsheet formula engines are deceptively complex. We evaluated open-source options and found that each one either lacked the cell reference model we needed or was too tightly coupled to a specific rendering engine. Building our own gave us a parser that's designed for our data model from the start.

### What it can do

The engine ships with 20 functions covering the most-used operations: arithmetic, string manipulation, conditionals, and aggregation. Cell references — including ranges like \`A1:B3\` — work across tabs.

### What it can't do (yet)

No cross-sheet references, no named ranges, no array formulas. These are on the roadmap for Q4. We'd rather ship a solid 80% than delay GA for the remaining 20%.

### Performance

P95 evaluation time for a 1,000-cell sheet with 200 formulas is under 50ms. We're happy with that.

### Try it

The formula engine is available to all paid plans today. Open any Helix Sheet and type \`=\` in a cell to start.

---

*[TODO: Add a 2-minute Loom demo of the formula engine]*
`,
  },
  {
    idx: 42,
    title: "DevConf 2026 Talk Proposal",
    folderId: FOLDER.marketing,
    tags: ["marketing","conference"],
    markdown: `# DevConf 2026 Talk Proposal

## Title

Building a modular monolith for 8 connected surfaces

## Abstract

Most teams building a productivity platform end up either with a fragmented bundle of microservices that are hard to keep consistent, or a monolith that turns into a big ball of mud. We built Helix — Mail, Calendar, Drive, Docs, Sheets, Slides, Chat, and Meet in one codebase — as a modular monolith, and it's working better than expected.

In this talk, we'll walk through:
- The shared data model that makes cross-surface features possible
- The permissions model that keeps 8 surfaces consistent without repeating authorization logic
- The outbox pattern that gives us reliable side effects without distributed transactions
- How the Helix assistant treats every surface as a tool it can call

## Speaker

Riley Chen, Lead Engineer, Helix

## Format

40-minute talk + 10-minute Q&A

## Why DevConf 2026

DevConf attracts the audience we want to reach: senior engineers at companies building internal tools or evaluating collaboration platforms. Our talk gives them a concrete architecture story, and it positions Helix as a serious engineering organization.
`,
  },
  // --- Legal docs (idx 43-47) ---
  {
    idx: 43,
    title: "Data Processing Agreement Template",
    folderId: FOLDER.legal,
    tags: ["legal","compliance"],
    markdown: `# Data Processing Agreement Template

## Parties

**Data Controller**: [Customer legal entity]
**Data Processor**: Helix Technologies, Inc.

## Scope

This DPA governs the processing of personal data by Helix Technologies on behalf of the Customer in connection with the Helix workspace services.

## Processing activities

Helix processes the following categories of personal data as instructed by the Customer:
- Account and profile data (name, email, job title)
- Workspace content data (mail messages, documents, calendar events, chat messages)
- Usage and log data

## Security measures

Helix maintains the following security measures:
- Encryption at rest (AES-256) and in transit (TLS 1.3)
- Access controls based on least privilege
- Regular penetration testing
- SOC 2 Type II certification (in progress)

## Sub-processors

Helix uses the following sub-processors:
- CloudSupplier (object storage, US or EU region)
- Postmark (mail delivery)
- PagerDuty (incident management)

## Data subject rights

Helix will assist Customer in responding to data subject requests (access, deletion, portability) within 30 days.

## Breach notification

Helix will notify Customer within 72 hours of becoming aware of a personal data breach.
`,
  },
  {
    idx: 44,
    title: "Incident Postmortem Template",
    folderId: FOLDER.legal,
    tags: ["engineering","operations","legal"],
    markdown: `# Incident Postmortem Template

## Incident summary

**Date**: [Date]
**Duration**: [Start] – [End] ([Duration])
**Severity**: P[1/2/3]
**Services affected**: [List]
**Customer impact**: [Describe impact on users/customers]

## Timeline

| Time (UTC) | Event |
| --- | --- |
| HH:MM | Monitoring alert fired |
| HH:MM | IC acknowledged |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Incident resolved |

## Root cause

[One clear paragraph describing what went wrong and why.]

## Contributing factors

- [Factor 1]
- [Factor 2]

## What went well

- [Thing 1]

## What could be improved

- [Thing 1]

## Action items

| Action | Owner | Due date |
| --- | --- | --- |
| [Action] | [Name] | [Date] |

## Notes

This postmortem is blameless. The goal is to improve systems, not assign fault. All contributing factors are system factors.
`,
  },
  // --- Data/analytics docs (idx 45-50) ---
  {
    idx: 45,
    title: "Analytics Data Dictionary",
    folderId: FOLDER.data,
    tags: ["data","analytics"],
    markdown: `# Analytics Data Dictionary

## Events

### \`workspace.session.started\`
User opened the workspace (new browser session or app launch).

Fields: \`actor_id\`, \`org_id\`, \`client\` (web/mobile), \`timestamp\`

### \`mail.thread.opened\`
User opened a mail thread.

Fields: \`actor_id\`, \`org_id\`, \`thread_id\`, \`from_notification\` (bool), \`timestamp\`

### \`doc.document.opened\`
User opened a document.

Fields: \`actor_id\`, \`org_id\`, \`document_id\`, \`source\` (drive/link/notification), \`timestamp\`

### \`assistant.action.confirmed\`
User confirmed an assistant action.

Fields: \`actor_id\`, \`org_id\`, \`action_type\`, \`surface\`, \`chained\` (bool), \`timestamp\`

### \`drive.file.uploaded\`
User uploaded a file to Drive.

Fields: \`actor_id\`, \`org_id\`, \`object_id\`, \`mime_type\`, \`size_bytes\`, \`timestamp\`

## Dimensions

- **Surface**: one of \`mail\`, \`drive\`, \`docs\`, \`calendar\`, \`chat\`, \`sheets\`, \`slides\`, \`meet\`, \`assistant\`
- **Plan tier**: \`starter\`, \`team\`, \`enterprise\`
- **Cohort week**: ISO week of the user's first session

## Metrics

| Metric | Definition |
| --- | --- |
| DAU | Distinct actors with at least one session in a day |
| WAU | Distinct actors with at least one session in a week |
| Activation | User uses 3+ surfaces in a single week |
| D7 retention | % of week-1 users with at least one session in week 2 |
`,
  },
  {
    idx: 46,
    title: "Data Warehouse Overview",
    folderId: FOLDER.data,
    tags: ["data","engineering"],
    markdown: `# Data Warehouse Overview

## Architecture

Event data flows from the application outbox → Kinesis → S3 → Snowflake. Transformation is handled by dbt models in the \`helix/data\` repo.

## Key marts

| Mart | Owner | Refresh |
| --- | --- | --- |
| \`mart_sessions\` | Rosa Kim | Hourly |
| \`mart_activation\` | Rosa Kim | Daily |
| \`mart_surfaces\` | Evan Brooks | Daily |
| \`mart_churn_risk\` | Rosa Kim | Daily |
| \`mart_assistant\` | Evan Brooks | Daily |

## Access

Analysts connect to Snowflake via the Helix-internal Metabase instance at http://metabase.internal. Write access to the warehouse is restricted to the data engineering team.

## Data quality

dbt tests run on every model. Freshness alerts fire in #data-alerts when a mart is more than 2 hours behind schedule.

## Retention

Raw event data is retained for 2 years. Aggregated marts are retained indefinitely.
`,
  },
  {
    idx: 47,
    title: "Monthly Product Metrics Report — April 2026",
    folderId: FOLDER.data,
    tags: ["data","product","reporting"],
    markdown: `# Monthly Product Metrics Report — April 2026

## Executive summary

April was our best activation month to date. DAU grew 12% MoM, and multi-surface activation (3+ surfaces in a week) reached 41% of active users, up from 35% in March.

## Key metrics

| Metric | April | March | MoM |
| --- | --- | --- | --- |
| DAU | 1,840 | 1,642 | +12% |
| WAU | 3,210 | 2,988 | +7% |
| Activation (3+ surfaces) | 41% | 35% | +6pp |
| D7 retention | 68% | 65% | +3pp |
| Assistant actions confirmed | 12,400 | 8,900 | +39% |

## Surface breakdown

| Surface | DAU | MoM |
| --- | --- | --- |
| Mail | 1,820 | +11% |
| Docs | 1,340 | +15% |
| Calendar | 1,290 | +10% |
| Chat | 1,190 | +8% |
| Drive | 1,050 | +13% |
| Sheets | 610 | +42% |
| Meet | 520 | +6% |
| Slides | 340 | +18% |

## Notable trends

- Sheets DAU growth was driven by the formula engine beta opening to all paid plans on Apr 7.
- Assistant confirmed actions grew 39% — the "draft + attach" flow is the most-used chain.
- D7 retention improvement correlates with the improved onboarding checklist shipped Mar 31.
`,
  },
  // --- Additional cross-surface docs (idx 48-80) ---
  {
    idx: 48,
    title: "Meet Architecture",
    folderId: FOLDER.backend,
    tags: ["engineering","meet"],
    markdown: `# Meet Architecture

## Signaling

Meet uses a Jitsi-based WebRTC infrastructure. The Helix backend manages room creation, access control, and recording — Jitsi handles the actual media relay.

## Room lifecycle

1. Room created (either directly or from a calendar event)
2. Participants join via the room token (verified against the \`permissions\` table)
3. Session starts; a system message is posted to the thread
4. Session ends; summary and recording (if enabled) are attached as messages

## Recording

Recordings are captured by a Jitsi recording bot, uploaded to object storage, and stored as \`kind='recording'\` objects. A system message in the meet thread links to the recording and transcript.

## Access control

Access to a meet room is governed by the \`permissions\` table (\`resource_type='meet_room'\`). The room token is issued server-side and is short-lived (30 minutes).
`,
  },
  {
    idx: 49,
    title: "Search Architecture",
    folderId: FOLDER.backend,
    tags: ["engineering","search"],
    markdown: `# Search Architecture

## Indexing

Search is powered by Postgres full-text search with \`tsvector\` columns on \`threads\`, \`messages\`, \`objects\`, and \`docs_documents\`. Incremental indexing runs via the outbox worker after writes.

## Query flow

1. User types in the search bar
2. Frontend debounces at 200ms and calls \`/api/v1/search\`
3. API parses the query, applies permission filters, and runs the FTS query
4. Results are ranked by recency × relevance score

## Limitations

- No semantic search (yet)
- Cross-surface search is available but results are ranked independently per surface
- File content indexing is planned but not yet implemented

## Future direction

A dedicated search service (Typesense or Elasticsearch) is in the Q4 backlog. The Postgres FTS approach is accurate enough for now but will not scale past ~5M rows per surface.
`,
  },
  {
    idx: 50,
    title: "Notifications Design",
    folderId: FOLDER.product,
    tags: ["product","notifications"],
    markdown: `# Notifications Design

## Channels

1. **In-app bell**: real-time, every notification type
2. **Email digest**: configurable — immediate, hourly, or daily
3. **Push notifications**: mobile only, high-priority events

## Notification types

| Type | Priority | Email | Push |
| --- | --- | --- | --- |
| @mention | High | Immediate | Yes |
| Document shared | Medium | Hourly | No |
| Calendar invite | High | Immediate | Yes |
| Comment on your doc | Medium | Hourly | No |
| Meet recording ready | Low | Daily | No |
| Security alert | Critical | Immediate | Yes |

## Fatigue reduction

- Notifications are grouped by object: 3 comments on the same doc → one notification
- Email digests are skipped if the user was online within the last hour
- Users can snooze notifications per-surface for up to 7 days

## Do-not-disturb

Respects the device's DND schedule. In-app notifications are still delivered; push and email are suppressed.
`,
  },
  {
    idx: 51, title: "Infrastructure Roadmap", folderId: FOLDER.infra, tags: ["engineering","infrastructure"],
    markdown: `# Infrastructure Roadmap

## H1 2026 (done)
- Postgres 16 upgrade
- Object storage migration to geo-redundant bucket
- Redis Sentinel → Redis Cluster

## H2 2026 (planned)
- Storage tier for enterprise (dedicated S3 buckets per org)
- Second database read replica for the enterprise tier
- Horizontal scaling of the outbox worker
- Kubernetes migration for the API server

## FY2027 (tentative)
- Global CDN for Drive files
- Multi-region active-active database
- SOC 2 Type II certification audit
`,
  },
  {
    idx: 52, title: "Mobile Engineering Handbook", folderId: FOLDER.frontend, tags: ["engineering","mobile"],
    markdown: `# Mobile Engineering Handbook

## Stack
React Native + Expo. Shared business logic with the web app via the \`@helix/sdk\` package.

## Platforms
iOS 16+ and Android 13+.

## Key differences from web
- Navigation uses React Navigation (stack + bottom tabs)
- Offline reads are cached in SQLite via WatermelonDB
- Push notifications via Expo Notifications

## Releases
Beta builds are distributed via Expo EAS. Production releases follow a two-week cycle, aligned with the web release.

## Testing
Detox for E2E on iOS and Android simulators. Unit tests run on Node.
`,
  },
  {
    idx: 53, title: "Docs Architecture", folderId: FOLDER.backend, tags: ["engineering","docs"],
    markdown: `# Docs Architecture

## Collaborative editing
Real-time collaboration uses Yjs + WebSocket. Each document has a Yjs doc identified by the document ID. The server applies updates to the in-memory Yjs doc and persists the state vector to Postgres on every change.

## Persistence
\`docs_documents.ydoc_state\` stores the full Yjs state. \`docs_updates\` is an append-only log of incremental updates for history/audit.

## Presence
Presence (cursor position, selection) is broadcast peer-to-peer via Yjs awareness and is not persisted.

## Export
Documents can be exported to Markdown or plain text. PDF export is planned.

## Version history
The \`docs_updates\` table records every incremental save. The frontend can replay updates to reconstruct any past state.
`,
  },
  {
    idx: 54, title: "Slides Architecture", folderId: FOLDER.backend, tags: ["engineering","slides"],
    markdown: `# Slides Architecture

## Data model
\`slide_decks\` is the parent. Each deck has ordered \`slides\` rows with a \`layout\` and a \`content\` JSONB column.

## Layouts
Six supported layouts: title, agenda, bullets, stats, split, image. The frontend renders each layout from the content JSON.

## Collaboration
Slides use the same permissions model as other objects. Collaborative editing is not yet real-time — last-write-wins with conflict warning. Real-time co-editing is Q3.

## Export
Decks export to PDF. PPTX export is planned for enterprise.

## Presenter mode
The presenter view shows speaker notes and a next-slide preview. Attendees see the current slide only.
`,
  },
  {
    idx: 55, title: "Sheets Architecture", folderId: FOLDER.backend, tags: ["engineering","sheets"],
    markdown: `# Sheets Architecture

## Data model
\`sheets\` → \`sheet_tabs\` → \`sheet_cells\`. Each cell stores its string value and a JSON format object (bold, italic, background color, number format).

## Formula evaluation
The formula engine parses formulas at write time and stores both the raw formula and the evaluated value. Re-evaluation is triggered whenever a referenced cell changes.

## Collaboration
Sheet cells use optimistic locking — last write wins. A CRDT-based approach is planned for Q4.

## Import/export
CSV import and export are supported. XLSX import is in beta.

## Performance
Cell reads are batched; the frontend requests a tab's worth of cells at once. For large sheets (>10,000 cells), virtual scrolling limits the rendered range.
`,
  },
  {
    idx: 56, title: "Calendar Architecture", folderId: FOLDER.backend, tags: ["engineering","calendar"],
    markdown: `# Calendar Architecture

## Data model
\`cal_calendars\` → \`cal_events\` + \`cal_attendees\`. Events belong to one calendar; attendees can be actors (internal) or external email addresses.

## iCal compatibility
Events can be exported as .ics files. Inbound iCal data (from external invites) is parsed and merged at the ingest layer.

## Recurring events
Recurring events store the recurrence rule in the event row (RRULE format). Occurrences are not expanded at write time — the API expands them on read for the requested date range, up to a cap.

## Time zone handling
All times are stored in UTC. Display timezone is per-calendar, per-user-preference, or per-event. The API returns UTC; the frontend converts to display timezone.

## Free/busy
The /freebusy API endpoint accepts a list of actor IDs and a date range and returns the union of their busy intervals. Used by the event creation flow to find open slots.
`,
  },
  {
    idx: 57, title: "Drive Architecture", folderId: FOLDER.backend, tags: ["engineering","drive"],
    markdown: `# Drive Architecture

## Objects model
Files are rows in the \`objects\` table (kind='file'). Every object has a storage key pointing to object storage. Apps (docs, sheets, slides) own objects rows with their own IDs as a shared primary key.

## Folders
\`drive_folders\` is a self-referential table (parent_folder_id). Folder membership is stored as \`metadata.folderId\` on the object row (no join table).

## Upload flow
1. Client requests an upload URL from the API
2. API creates a draft \`objects\` row and a pre-signed PUT URL
3. Client uploads directly to object storage
4. Client notifies API that upload is complete
5. API validates the SHA-256 and marks the object ready

## Versions
\`drive_versions\` tracks every upload of the same object. The current version is the one with the highest \`version_number\`. Previous versions are retained for 30 days by default.

## Search
Drive files are indexed into the FTS system on upload and on rename. Content indexing (searching inside PDFs) is planned.
`,
  },
  {
    idx: 58, title: "Release Notes — v2.7", folderId: FOLDER.engineering, tags: ["engineering","releases"],
    markdown: `# Release Notes — v2.7

## Released: May 14, 2026

## New features

- **Mail importer**: added resumable cursor and chunked pagination — resolves timeouts on large mailboxes (80k+ messages)
- **Sheets formula engine**: 20 functions now available to all paid plans
- **Drive browser**: inline folder expansion (no full-page navigation)
- **Calendar**: free/busy view when creating events with attendees

## Improvements

- Mail: thread state sync is now real-time via WebSocket (previously polling)
- Chat: read receipt delivery reduced from 5s to <1s
- Meet: recording upload is now resumable on network interruption
- Search: FTS indexing latency reduced by 40% via batched writes

## Bug fixes

- Fixed a race condition in the calendar attendee sync that could result in duplicate entries
- Fixed an edge case in the MIME parser that dropped attachments on messages with malformed Content-Type headers
- Fixed tab navigation order in the share dialog

## Breaking changes

None.
`,
  },
  {
    idx: 59, title: "Release Notes — v2.6", folderId: FOLDER.engineering, tags: ["engineering","releases"],
    markdown: `# Release Notes — v2.6

## Released: April 22, 2026

## New features

- **Assistant**: first release of multi-step action chaining (draft + attach)
- **Docs**: real-time presence (cursor position visible to collaborators)
- **Slides**: six presentation layouts: title, agenda, bullets, stats, split, image
- **Sheets**: CSV import/export

## Improvements

- Mail: category inference (primary/updates/promotions/social) is now available
- Drive: version history panel in the detail panel
- Calendar: recurring event support for daily, weekly, and monthly patterns

## Bug fixes

- Fixed a session expiry edge case that could log users out mid-session
- Fixed PDF attachment rendering on some mobile browsers
- Fixed occasional WebSocket disconnects on Safari

## Breaking changes

- The \`/api/v1/drive/files\` endpoint now requires explicit \`folderId\` parameter (previously inferred from session). Clients must be updated.
`,
  },
  {
    idx: 60, title: "Quarterly Engineering All-Hands Deck Notes", folderId: FOLDER.engineering, tags: ["engineering","planning"],
    markdown: `# Quarterly Engineering All-Hands — Q2 2026 Notes

## Themes

Q2 was about reliability and the foundation for the enterprise tier. We shipped the storage migration without downtime, improved search latency by 40%, and fixed the mail importer issue that was blocking the Northwind enterprise launch.

## Shipped

- Mail importer resumable cursor
- Real-time WebSocket for mail thread state
- Drive version history panel
- Sheets CSV import
- Assistant action chaining (beta)
- Postgres index audit — removed 3 table scans from hot paths

## What we learned

- The formula engine is further ahead than Q1 projections. Evan's batched evaluation approach was the key insight.
- Incident response on the search outage was slow — we've added a dedicated search runbook and rotated the on-call responsibility.
- The WebSocket connection management needs work at scale. We saw instability above 400 concurrent connections.

## Q3 focus

- Assistant chaining to GA
- Meet recording pipeline
- Horizontal scaling for WebSocket connections
- SOC 2 audit prep (Gabriel leading)
`,
  },
  // Additional quick docs to reach ~80 total
  {
    idx: 61, title: "Persona: Enterprise IT Admin", folderId: FOLDER.ux, tags: ["research","ux","enterprise"],
    markdown: `# Persona: Enterprise IT Admin

## Name: Jordan (composite)

**Role**: IT Manager at a 200-person software company
**Age**: 38
**Primary tools**: Identity provider admin console, SIEM, MDM, ticketing system

## Goals

- Provision and deprovision users with no manual steps
- Get an audit trail that satisfies compliance requirements
- Reduce shadow IT by offering tools IT can actually endorse

## Frustrations

- SaaS products that can't export audit logs to the SIEM
- Onboarding flows that require IT to individually invite each user
- Sharing models that users bypass ("just email me the doc")

## Helix relationship

Jordan is not a daily Helix user but is the economic buyer. They will approve or block the Helix deployment based on:
1. Audit log export (SIEM-compatible feed) ← top blocker
2. SCIM/SSO integration ← required for 200-seat deal
3. Data residency options ← required for EU subsidiaries
`,
  },
  {
    idx: 62, title: "Persona: Power User (Ops Lead)", folderId: FOLDER.ux, tags: ["research","ux"],
    markdown: `# Persona: Power User (Ops Lead)

## Name: Sam (composite)

**Role**: Operations Lead at a fast-growing startup
**Age**: 31
**Primary tools**: Mail, spreadsheets, project management, chat

## Goals

- Get things done fast, with as few clicks as possible
- Keep track of what the team is doing without sitting in meetings
- Have everything in one place — not 12 tabs

## Frustrations

- Email that requires too many clicks to archive or reply
- Documents that are disconnected from the conversation that created them
- Spreadsheets that can't do basic math without a separate formula tool

## Helix relationship

Sam is a daily power user. They push the assistant to its limits and are the team's go-to person for "how do I do X in Helix." Sam's feedback is the most actionable.

Top requests from Sam:
1. Keyboard shortcuts across Mail and Drive
2. A way to turn any mail thread into a task with a due date
3. Better search — natural language, not just keyword
`,
  },
  {
    idx: 63, title: "Weekly Engineering Notes — May 19", folderId: FOLDER.engineering, tags: ["engineering","notes"],
    markdown: `# Weekly Engineering Notes — May 19, 2026

## Shipped
- Mail importer fix to production (PR #482 — Sasha)
- Drive inline folder expansion (PR #478 — Celia)
- Calendar free/busy view (PR #476 — Ben)

## In review
- Formula engine performance optimization (PR #485 — Evan)
- Chat message thread replies (PR #481 — Kai)
- WebSocket connection pooling (PR #480 — Alex)

## In progress
- Meet recording pipeline: cloud storage integration (Ben, target May 28)
- Search latency improvements: in-process batching (Ivan, target May 26)
- Mobile: offline read cache (Kai, target Jun 4)

## Blocked
- SOC 2 audit prep: waiting on legal to confirm scope (Gabriel — loop in Lena)

## Shoutouts
Big thanks to Sasha for turning the Northwind mail importer issue around in a single day. That was a critical path item.

## Next week
- Sprint review on Thursday (demo the formula engine + recording pipeline progress)
- Architecture review for the WebSocket pooling proposal (Alex presenting)
`,
  },
  {
    idx: 64, title: "Weekly Engineering Notes — May 12", folderId: FOLDER.engineering, tags: ["engineering","notes"],
    markdown: `# Weekly Engineering Notes — May 12, 2026

## Shipped
- Sheets formula engine to all paid plans (GA)
- Drive version history panel (design shipped in v2.7)
- Mail: real-time thread state via WebSocket

## In review
- Mail importer pagination fix (PR #482 — Sasha)
- Calendar attendee dedup fix (PR #470 — Ben)

## In progress
- Drive browser redesign (Celia + Sam — in design review)
- Meet recording: signaling integration (Ben + Will)
- WebSocket scaling investigation (Alex)

## Notes from the search outage post-mortem
Root cause was a missing index on the FTS query path after the Postgres 16 upgrade. Added the index in a hotfix. Action items:
- Add query plan review to the deploy checklist (Ivan)
- Add dedicated search runbook (Omar)
- Rotate search on-call coverage to Ivan and Omar in addition to Alex

## Next week
- Sprint planning Monday
- Northwind fix expected to land Thursday
`,
  },
  {
    idx: 65, title: "Hiring Loop Guide — Backend Engineer", folderId: FOLDER.hiring, tags: ["people","hiring"],
    markdown: `# Hiring Loop Guide — Backend Engineer

## Role context
We're hiring a senior backend engineer to work on the mail and calendar surfaces. The ideal candidate has strong distributed systems fundamentals and is comfortable owning a surface end to end.

## Loop structure

**Recruiter screen** (30 min, Vera): logistics, comp, motivation.

**Hiring manager screen** (45 min, Hannah): leadership, team dynamics, past experience.

**Technical depth** (60 min, Alex or Ulrich): systems design. Ask them to design a distributed inbox — we're looking for a clean mental model, not a specific answer.

**Coding** (60 min, Ben or Celia): live coding in their language of choice. One medium-difficulty algorithmic problem + one systems problem.

**Cross-functional** (45 min, Diana or Fiona): how do they work with product and design? Communication, ambiguity tolerance.

## Scoring rubric

Score each dimension 1–4:
1. Strong no hire
2. Lean no hire
3. Lean hire
4. Strong hire

Consensus is required. A single 1 from any interviewer is a no hire.

## Debrief

Book the debrief for 30 minutes, the morning after the onsite. Vera sends the Lever link. Do not discuss scores before the debrief.
`,
  },
  {
    idx: 66, title: "Company Values", folderId: FOLDER.people, tags: ["people","culture"],
    markdown: `# Company Values

## 1. Ship real things

We value working software over slides and plans. Prototypes beat proposals.

## 2. Own it end to end

Take responsibility from the first commit to the customer. That includes reading the error logs.

## 3. Disagree and commit

Have the argument in the room. Once a decision is made, everyone rows in the same direction.

## 4. Default to open

Share early and often. Default to transparency — internally and with customers. Write things down.

## 5. Take care of each other

We support one another's growth. Ask for help early. Give feedback directly and kindly.

## 6. Earn trust every day

We earn trust through consistency, reliability, and honesty. We say what we mean.
`,
  },
  {
    idx: 67, title: "Offsite Agenda — 2026", folderId: FOLDER.people, tags: ["people","culture"],
    markdown: `# Company Offsite Agenda — 2026

## Location
The Foundry, downtown. June 11–13.

## Day 1 — Strategy
- 09:00 Welcome + housekeeping
- 09:30 Company state of the union (30 min)
- 10:00 Q3 roadmap presentation and debate (90 min)
- 12:00 Lunch
- 13:30 Surface breakouts: each team presents their Q3 goals (120 min)
- 16:00 Open time / 1:1s
- 18:30 Team dinner at The Collective

## Day 2 — Workshops
- 09:00 Workshop 1: "Building better customer empathy" (Fiona facilitating)
- 11:00 Workshop 2: "Scaling the team" (Vera facilitating)
- 13:00 Lunch
- 14:00 Workshop 3: open — topic voted on by team
- 16:30 Free time

## Day 3 — Retro and social
- 09:00 Annual retrospective: what to keep, drop, start
- 11:00 Hallway track / open space
- 12:00 Lunch + departures
- 14:00 Optional: city walking tour for those staying overnight

## Notes
- All sessions recorded (Meet room available for remote attendees)
- Dietary needs: add to the offsite sheet
- Travel: book by June 1 for best rates
`,
  },
  {
    idx: 68, title: "Incident Report: Search Outage — May 7", folderId: FOLDER.infra, tags: ["engineering","operations"],
    markdown: `# Incident Report: Search Outage — May 7, 2026

## Summary
A missing database index caused elevated search latency and partial outage for approximately 90 minutes on May 7, 2026.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 14:02 | PagerDuty alert: search P95 latency > 5s |
| 14:06 | Ivan acknowledged; opened incident bridge |
| 14:15 | Root cause identified: missing index on FTS query after Postgres 16 upgrade |
| 14:22 | Index created concurrently (no lock) |
| 14:38 | Latency back to normal; incident closed |

## Root cause
The Postgres 16 upgrade changed the planner's cost estimates, causing it to prefer a sequential scan over a previously-used partial index on the FTS query path. The index was dropped during a cleanup pass that incorrectly marked it as unused.

## Impact
Search was degraded for ~90 minutes. No data loss or security impact.

## Action items

| Action | Owner | Status |
| --- | --- | --- |
| Add FTS index to deploy checklist | Ivan Petrov | Done |
| Add dedicated search runbook | Omar Hassan | Done |
| Rotate search on-call coverage | Hannah Price | Done |

## What went well
- Monitoring caught the issue within 4 minutes
- Root cause identified in 9 minutes
- Fix applied with no downtime (concurrent index build)
`,
  },
  {
    idx: 69, title: "Q1 2026 Retrospective", folderId: FOLDER.product, tags: ["product","planning"],
    markdown: `# Q1 2026 Retrospective

## What went well

- Shipped the legacy mail migration on time and under budget
- The design system v2 shipped with zero regression complaints from the team
- The formula engine parser reached 70% completion ahead of plan

## What didn't go well

- The storage migration slipped three weeks due to an underestimated dependency on the enterprise tier work
- On-call rotation had two coverage gaps in February
- The mobile release cycle fell out of sync with the web release

## Key learnings

1. Infrastructure migrations need a dedicated buffer — we keep underestimating them
2. On-call coverage gaps happen when people are out; we need automated rotation in PagerDuty
3. Mobile and web should share the same release cycle (deferred to Q2 as a process change)

## Q2 commitments

- Strict: every infrastructure migration has a 20% time buffer in the estimate
- Strict: automated on-call rotation in PagerDuty by April 1
- Strict: shared web/mobile release cycle starting May 1
`,
  },
  {
    idx: 70, title: "Slack → Chat Migration Guide", folderId: FOLDER.onboarding, tags: ["onboarding","chat"],
    markdown: `# Slack → Helix Chat Migration Guide

## What migrates

- All public channels → Helix spaces (direct mapping by channel name)
- DMs between users in the org → Helix DMs
- Message history is preserved with original timestamps

## What does not migrate

- Slack bots and apps (replace with Helix assistant workflows)
- Emoji reactions on historical messages
- Slack-specific formatting (strikethrough, spoiler tags)

## How to migrate

1. Export your Slack workspace data (Workspace settings → Import/Export)
2. Upload the export ZIP to \`import.helix.local\`
3. Map Slack user emails to Helix actor emails
4. Review the preview (shows channel count, message count, date range)
5. Confirm the import

The import runs in the background. Large workspaces (>100k messages) may take 15–30 minutes.

## After migration

- The Slack → Helix bridge integration is available for a 30-day transition period
- Messages sent in Slack are mirrored to the corresponding Helix space
- After 30 days, the bridge is disabled and Slack is decommissioned

## FAQs

**Will I lose my message history?** No — all messages are imported with their original timestamps.

**What about reactions?** Reaction counts are not migrated (Slack API limitation).
`,
  },
  // Continuing to hit 80 total with shorter docs
  {
    idx: 71, title: "Meet Recording Setup", folderId: FOLDER.backend, tags: ["engineering","meet"],
    markdown: `# Meet Recording Setup

## Prerequisites
- The recording pipeline requires the object storage backend to be configured
- Enable the \`meet_recording\` feature flag for the org

## How recording works
When a host starts recording, the Jitsi recording bot joins the room and captures a mixed audio/video stream. On session end, the recording is uploaded to object storage and a transcription job is queued.

## Transcription
Transcription uses Whisper (self-hosted) for English. Other languages are in the backlog. Transcription accuracy targets: >90% on English audio with low background noise.

## Storage
Recordings are stored as \`kind='recording'\` objects. Default retention is 90 days for Team, 365 days for Enterprise.
`,
  },
  {
    idx: 72, title: "Drive Sharing Model", folderId: FOLDER.backend, tags: ["engineering","drive"],
    markdown: `# Drive Sharing Model

## Permission levels
- **Owner**: can read, write, delete, and share
- **Writer**: can read and write
- **Commenter**: can read and leave comments
- **Reader**: can read only

## Sharing scope
Permissions can be granted to individual actors, to "all org members", or (future) to external email addresses.

## Inheritance
Folder permissions are inherited by files within the folder, but are not automatically applied to sub-folders. Inheritance is computed at read time, not stored.

## Link sharing
A "share link" grants reader access to anyone with the link, within the org only by default. "Anyone on the internet" link sharing is an enterprise-only feature.
`,
  },
  {
    idx: 73, title: "Q3 Engineering Roadmap Detail", folderId: FOLDER.roadmap, tags: ["engineering","planning"],
    markdown: `# Q3 Engineering Roadmap Detail

## Backend

| Item | Owner | Target | Status |
| --- | --- | --- | --- |
| Assistant chaining (GA) | Alex Torres | Aug 15 | In progress |
| Meet recording pipeline | Ben Hayes | Sep 10 | In progress |
| WebSocket pooling | Alex Torres | Jul 15 | In review |
| SOC 2 prep | Gabriel Luna | Sep 30 | In progress |

## Frontend

| Item | Owner | Target | Status |
| --- | --- | --- | --- |
| Drive browser redesign | Celia Wright | Jul 20 | In design |
| Chat thread replies | Kai Nakamura | Jul 10 | In review |
| Keyboard shortcut MVP | Celia Wright | Aug 1 | Not started |

## Infrastructure

| Item | Owner | Target | Status |
| --- | --- | --- | --- |
| Second read replica | Omar Hassan | Jul 30 | Planned |
| Enterprise storage tier | Omar Hassan | Aug 20 | Planned |
| Horizontal API scaling | Will Cross | Sep 15 | Not started |
`,
  },
  {
    idx: 74, title: "Northwind Account Notes", folderId: FOLDER.people, tags: ["customer","enterprise"],
    markdown: `# Northwind Account Notes

## Account overview
Enterprise pilot — 85 seats. Signed the pilot agreement in March 2026. Renewal in June 2026.

## Key contacts
- Alex Rivera — Staff Engineer (technical buyer)
- Sandra Cho — IT Manager (economic buyer / gatekeeper)
- Derek Moss — VP Engineering (executive sponsor)

## Current usage
- Mail: 95% of seats active
- Docs: 60% of seats active (growing)
- Chat: 85% of seats active
- Calendar: 70% of seats active
- Sheets: 30% of seats active
- Meet: 40% of seats active

## Open issues
1. Audit log export to their SIEM — **critical for renewal** (see infra roadmap)
2. SCIM provisioning — Sandra wants automated user sync from Okta
3. Mobile app occasional WebSocket drops on iOS — Kai is investigating

## Renewal notes
Usage is up 40% YoY. Renewal at current pricing is expected; possible upsell to Enterprise Plus for data residency. Nadia is leading the commercial negotiation.
`,
  },
  {
    idx: 75, title: "Assistant Tool Registry Spec", folderId: FOLDER.backend, tags: ["engineering","assistant"],
    versions: 1,
    markdown: `# Assistant Tool Registry Spec

## Overview
The assistant tool registry maps tool names to implementations. Each tool declares:
- Name and description
- Input schema (Zod)
- Required scopes (platform permissions)
- Confirmation required (boolean)
- The async handler function

## Registration
Tools are registered at module load time:

\`\`\`typescript
registry.register({
  name: 'mail.draft.create',
  description: 'Create a draft mail reply',
  inputSchema: z.object({ threadId: z.string(), body: z.string() }),
  requiredScopes: ['mail.write'],
  confirmationRequired: false,
  handler: async (input, actor) => { ... },
});
\`\`\`

## Execution flow
1. Assistant model outputs a tool call
2. Registry validates the input against the Zod schema
3. Registry checks actor has the required scopes
4. If confirmationRequired: create a \`pending_actions\` row and return a confirmation request
5. If not: execute the handler immediately

## Chaining
Chained tool calls are executed sequentially, with each call's output available to the next via the conversation context. A chain is atomic — if any step fails or is rejected, the whole chain rolls back.
`,
  },
  {
    idx: 76, title: "Technical Writing Style Guide", folderId: FOLDER.people, tags: ["culture","writing"],
    markdown: `# Technical Writing Style Guide

## Principles

1. **Be specific**: "the auth flow has a race condition on concurrent token refresh" beats "there's a bug in auth".
2. **Use active voice**: "the outbox worker processes the queue" not "the queue is processed by the outbox worker".
3. **Front-load the key information**: say what you mean in the first sentence.
4. **Short paragraphs**: three sentences max per paragraph in documentation.
5. **Use lists for steps and enumerations**: prose is for context, lists are for instructions.

## Docs vs comments

| Location | Purpose | Audience |
| --- | --- | --- |
| Code comments | Explain the "why", not the "what" | Future engineers |
| Module JSDoc | Document the public API | Callers |
| Docs folder | Architecture, decisions, runbooks | Team + new hires |

## Headings

Heading 1 is the document title only. Use heading 2 for major sections and heading 3 for sub-sections. Don't go deeper than heading 3.

## Code blocks

Always specify the language in fenced code blocks. Wrap lines at 80 characters for readability.
`,
  },
  {
    idx: 77, title: "Postmortem: Mail Delivery Delays — April 30", folderId: FOLDER.infra, tags: ["engineering","operations"],
    markdown: `# Postmortem: Mail Delivery Delays — April 30, 2026

## Summary
The outbound mail queue backed up for 45 minutes due to a deadlock in the outbox worker. All queued mail was delivered within 2 hours of the incident start.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 18:12 | First customer report of mail delivery delay |
| 18:20 | PagerDuty alert: outbox queue depth > 5000 |
| 18:22 | Will Cross acknowledged |
| 18:31 | Root cause: deadlock in outbox worker between mail delivery and drive indexing jobs |
| 18:35 | Mitigation: restarted outbox worker with job type isolation |
| 18:47 | Queue draining; deliveries resuming |
| 20:01 | Queue cleared; incident resolved |

## Root cause
The outbox worker processes both mail delivery and search indexing in the same job queue. A high-volume drive upload triggered a search indexing burst that contended for a shared lock with concurrent mail delivery rows.

## Impact
Approximately 3,400 outbound messages delayed 45–100 minutes. No messages were lost.

## Actions

| Action | Owner | Status |
| --- | --- | --- |
| Separate job queues for mail delivery and search indexing | Will Cross | Done |
| Add deadlock monitoring alert | Ivan Petrov | Done |
| Document outbox worker internals | Will Cross | In progress |
`,
  },
  {
    idx: 78, title: "API Rate Limiting Design", folderId: FOLDER.backend, tags: ["engineering","api"],
    markdown: `# API Rate Limiting Design

## Motivation
Without rate limiting, a single misbehaving client can degrade the service for everyone. Rate limits also protect against credential stuffing and scraping.

## Limits by tier

| Tier | Per-minute limit | Per-day limit |
| --- | --- | --- |
| Free/Starter | 120 req/min | 10,000 req/day |
| Team | 600 req/min | 50,000 req/day |
| Enterprise | 3,000 req/min | Custom |

## Implementation
Limits are enforced in the Fastify middleware using a sliding window counter in Redis. The counter key is \`ratelimit:{orgId}:{window}\`.

## Response
When a limit is exceeded, the API returns HTTP 429 with a \`Retry-After\` header indicating when the window resets.

## Exemptions
The outbox worker, the WebSocket connection handler, and the search indexer are exempt from rate limits (they use service account tokens with a separate scope).
`,
  },
  {
    idx: 79, title: "SLO Definitions", folderId: FOLDER.infra, tags: ["engineering","sre"],
    markdown: `# SLO Definitions

## Service level objectives

| SLO | Target | Error budget (30 days) |
| --- | --- | --- |
| API availability | 99.9% | 43.8 minutes |
| Mail delivery latency P95 | < 30s | — |
| Docs sync latency P99 | < 500ms | — |
| Search latency P95 | < 1s | — |
| Drive upload throughput | > 50 MB/s | — |

## Error budget policy
If the error budget for availability falls below 50% remaining in a month, the team pauses non-critical feature work until the budget recovers or the month resets.

## SLI measurement
Availability is measured by the Prometheus \`helix_api_request_total\` metric. A request is a failure if it returns 5xx or times out. 4xx errors are not counted.

## Review cadence
SLOs are reviewed in the monthly engineering all-hands. Budget burn rate is visible in the Grafana overview dashboard.
`,
  },
  {
    idx: 80, title: "Company Handbook", folderId: FOLDER.root, tags: ["people","culture"],
    markdown: `# Company Handbook

## Mission
We build the workspace where great teams do their best work.

## How we work

### Async by default
We write things down. Decisions are made in shared documents, not in ephemeral conversations. If it's not written down, it didn't happen.

### Meetings have an agenda
We do not hold meetings without an agenda. The agenda is shared at least 24 hours before the meeting.

### Bias for action
When in doubt, ship a small version and learn. Ask for forgiveness, not permission, on low-stakes decisions.

## Communication norms

- **Chat** is for quick, synchronous communication. It is not a record.
- **Mail** is for external communication and anything requiring a paper trail.
- **Docs** is where decisions, plans, and knowledge live permanently.
- **Calendar** is the source of truth for when things are happening.

## Feedback culture

We give feedback directly and early. Feedback is a gift. We separate the work from the person.

## Performance

Performance expectations are set during goal-setting at the start of each quarter. Reviews happen quarterly. Surprises at review time are a sign that something went wrong with feedback earlier.

## Benefits summary

See the Finance Onboarding Guide and the Payroll Compliance Guide for full details. Ask Vera Stone for any questions about benefits.
`,
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedDocs(sql: SeedSql, orgId: string): Promise<number> {
  for (const doc of DOCS) {
    const threadId   = uid("e000", doc.idx);
    const documentId = uid("e100", doc.idx);

    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'doc', ${doc.title}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict (id) do nothing
    `;

    const body = buildDocsBodyState(doc.markdown);
    await sql`
      insert into docs_documents (id, org_id, title, thread_id, owner_actor_id, created_by_actor_id, ydoc_state, ydoc_state_vector, update_seq, metadata)
      values (
        ${documentId}, ${orgId}, ${doc.title}, ${threadId}, ${ADMIN_ACTOR}, ${ADMIN_ACTOR},
        ${body.state}, ${body.stateVector}, ${doc.versions ?? 0},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, tags: [...doc.tags] })}
      )
      on conflict (id) do update set
        title          = excluded.title,
        ydoc_state     = excluded.ydoc_state,
        ydoc_state_vector = excluded.ydoc_state_vector,
        metadata       = excluded.metadata,
        updated_at     = now()
    `;

    // Shared-PK objects row.
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${documentId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`docs/${orgId}/${documentId}`},
        'application/vnd.helix.document', 0, null,
        ${json(sql, {
          source: WORKSPACE_SEED_LARGE_SOURCE,
          app: "docs",
          name: doc.title,
          title: doc.title,
          folderId: doc.folderId,
        })}
      )
      on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
    `;

    // Version history.
    for (let seq = 1; seq <= (doc.versions ?? 0); seq++) {
      const revision = buildDocsBodyState(`${doc.markdown}\n\nRevision ${String(seq)} — earlier draft.`);
      await sql`
        insert into docs_updates (id, org_id, document_id, actor_id, seq, update, metadata, created_at)
        values (
          ${uid("e200", doc.idx * 10 + seq)}, ${orgId}, ${documentId}, ${ADMIN_ACTOR},
          ${seq}, ${revision.state},
          ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, summary: `Revision ${String(seq)}` })},
          ${daysFromNow(-(10 - seq), 11)}
        )
        on conflict (id) do nothing
      `;
    }

    // Comments.
    for (const [ci, comment] of (doc.comments ?? []).entries()) {
      const actorId = teamId(comment.actorIdx);
      await sql`
        insert into docs_comments (id, org_id, document_id, actor_id, anchor, body, status, metadata, resolved_at)
        values (
          ${uid("e300", doc.idx * 10 + ci)}, ${orgId}, ${documentId}, ${actorId},
          ${json(sql, { blockId: `b${String(ci + 1)}` })}, ${comment.body},
          ${comment.resolved === true ? "resolved" : "open"},
          ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })},
          ${comment.resolved === true ? daysFromNow(-1, 14) : null}
        )
        on conflict (id) do nothing
      `;
    }

    await grantBoth(sql, orgId, "thread", threadId, "owner");
    await grantBoth(sql, orgId, "document", documentId, "owner");
  }

  return DOCS.length;
}
