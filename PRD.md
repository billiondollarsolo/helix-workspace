# Product Requirements Document: Helix Workspace

**Codename:** Helix
**Document version:** 1.4
**Status:** Draft for AI-assisted implementation
**Audience:** Autonomous coding agents (Claude Code, Cursor agents, Aider, Devin-style loops) and human reviewers

**Changes since v1.3 (the "frontend discipline + webhooks" pass):**

- **Visual identity:** the shadcn preset (`npx shadcn@latest init --preset b1D0dv72 --template vite`) is now canonical. The Material 3 token layer from earlier versions is dropped — the preset defines the visual truth.
- **Modals, never browser popups:** hard discipline rule. No `window.alert/confirm/prompt`, no `window.open` for confirmations, no `beforeunload` native dialog. All confirmations are in-app modal Dialogs.
- **Webhooks (in + out)** added as Phase 0 platform capabilities. Outbound to Slack/Discord/Teams/generic; inbound from GitHub/Stripe/Linear/generic with HMAC verification.
- **Frontend discipline patterns codified** (Section 11): persistent left rail, route-driven SPA navigation, suspense queries, route loaders, optimistic mutations as default, light/dark/system color modes, TanStack everywhere.
- **Branding & theming:** per-deployment branding (logo, accent) at Tier 2+; the preset's identity stays; admin overrides are constrained to logo/accent/display-name.

**Changes since v1.2 (carried forward from v1.3):**
- Plugin architecture as the spine — every feature is a plugin
- Four security tiers (Personal/Business/Enterprise/Sovereign) with per-layer overrides
- Pluggable AI: OpenAI-compat + Anthropic-compat + Bedrock + Vertex; pgvector + Qdrant + Milvus + Chroma + Weaviate
- Agent-first: MCP + OpenAPI + AsyncAPI + CLI; dedicated actors model with OAuth 2.1 client credentials
- Observability: OpenTelemetry + bundled Grafana + Tempo + Loki + Prometheus stack
- HA & deployment with tier-aware Helm chart

**Changes since v1.0 (deep history):**
- v1.1: Fastify v5 over Hono; RustFS over MinIO; Cerbos over SpiceDB
- v1.2: in-process SMTP (`smtp-server`); in-process Yjs sync; Better-Auth; consolidated `apps/helix` server

---

## 0. How to use this PRD (for AI agents)

This document is the source of truth for a long-running autonomous build. Read it end-to-end before generating any code. Cross-reference the numbered sections — they are linked from the task list in Section 17.

**Operating rules for the agent loop:**

1. **Never invent libraries or APIs.** If a library version is pinned in Section 6, use that exact version. If a behavior is unspecified, stop and add a clarifying question to `/QUESTIONS.md` rather than guessing.
2. **Work one task at a time** from the task list (Section 17). Each task has acceptance criteria — do not mark a task complete until every criterion passes.
3. **Every task ends with tests passing and a clean `pnpm typecheck`, `pnpm lint`, and `pnpm test`.** If they don't, the task isn't done.
4. **Commit after every task** with the message format `feat(<area>): <task title> [TASK-XXX]`.
5. **The plugin architecture in Section 4 is binding.** All features — including core ones — are built as plugins consuming the public SDK. There is no "internal API" with shortcuts. If you find yourself wanting to bypass the SDK, that means the SDK is missing a capability; add it via decision record instead.
6. **The architecture in Section 3 is binding.** Do not introduce frameworks, runtimes, or storage systems not listed in Section 6 without first writing a proposal in `/decisions/NNNN-<title>.md` and waiting for human review.
7. **When stuck for more than two iterations on the same error, stop and write the situation to `/BLOCKED.md` with reproduction steps.**
8. **All code must be TypeScript strict mode.** No `any` without a `// eslint-disable-next-line` and a justifying comment.
9. **Phase order matters.** Do not start a feature plugin (Phase 2+) before Phase −1 (platform foundation) is complete. The platform must exist before features that depend on it can be coherently built.

---

## 1. Executive summary

Helix is a self-hostable, open-source productivity platform that replaces Gmail, Google Chat, Google Drive, Google Docs, Google Calendar, and Google Meet for a single organization. It is architected as a **plugin platform with a strong cohesion core**: a small set of platform primitives owns the shared schema and runtime, and every feature — including mail, chat, drive, docs, calendar, meet, search, and AI — is implemented as a first-party plugin consuming the same public SDK that third-party plugins consume.

**Differentiating qualities:**

- **Cohesion by construction.** All features share one schema (`objects`, `threads`, `messages`, `permissions`, `actors`, `activity`), one search index, one notification bus, one auth model. There is no "mail database" and "chat database" to keep in sync.
- **Pluggable everywhere.** Auth provider, storage backend, search engine, video subsystem, LLM provider, embedding model, vector store, observability stack — all swappable via plugins implementing the same capability interfaces.
- **Security-tiered.** A single codebase supports deployments from a single-VPS basement install (Tier 1: Personal) to an air-gapped FIPS-validated installation with HSM-backed encryption and SIEM audit shipping (Tier 4: Sovereign). Tiers are configurable; admins can override any layer.
- **Agent-first.** Every human-usable affordance has an equivalent programmatic affordance. MCP server, OpenAPI 3.1 spec, AsyncAPI events, full CLI — generated from the same source of truth. Agents are first-class principals with their own actor identities, OAuth 2.1 client credentials, scoped permissions, rate/cost limits, and audit trails distinct from human users.
- **AI integrated, not bolted on.** AI capabilities (LLM, embeddings, vector store, transcription, OCR, vision, reranking) are first-class plugin capabilities. Feature plugins declare AI integration slots (compose-help, summarize, semantic-search) and platform-managed routing decides which configured provider handles which feature.
- **Observable.** OpenTelemetry instrumentation throughout; every request, tool call, LLM call, and permission check is traced. Bundled optional Grafana + Tempo + Loki + Prometheus stack provisioned via plugin.
- **Deployable.** Single Docker Compose for self-host, Helm chart for Kubernetes. Tier-conditional service composition: Tier 1 runs in 7 containers; higher tiers add observability stack, Vault, SPIRE, etc. on demand.

**Non-goals (v1):**

- Federation (no Matrix, no ActivityPub, no XMPP federation)
- Mobile native apps (web-responsive only in v1; React Native in v2)
- Multi-tenancy (one organization per deployment in v1; design preserves the option)
- End-to-end encrypted chat for v1 (designed-for in schema; implemented Tier 3+ in v1.5+)

---

## 2. Goals & success criteria

### 2.1 Product goals

- **G1.** A user can sign up, receive and send email at `user@<their-domain>`, with deliverability ≥95% to major providers (Gmail, Outlook, Yahoo) after proper DNS setup.
- **G2.** A user can participate in real-time chat (1:1 and rooms) with typing indicators, read receipts, threading, and emoji reactions.
- **G3.** A user can upload, share, preview, and collaboratively edit files in a Drive-like interface.
- **G4.** A user can create and edit rich-text documents collaboratively with live cursors.
- **G5.** A user can schedule events, invite attendees (internal + external email), and join video calls via Jitsi.
- **G6.** A single global search returns mail, chat messages, files, docs, and events in unified results, with optional semantic ranking when an embedding provider is configured.
- **G7.** Admin can install/uninstall plugins (including swapping storage backends, federated auth providers, vector stores, video backends) without rebuilding the app; external identity providers federate into the Helix session model, and local email/password remains available for owner/admin recovery.
- **G8.** Admin can set a security tier (Personal/Business/Enterprise/Sovereign) and override individual controls; the deployment topology adapts automatically.
- **G9.** Admin can configure one or more AI providers; a conversational "Helix Assistant" lets users invoke platform capabilities via natural language, with tool-call confirmation gates on destructive actions.
- **G10.** Agents (non-human actors) can be created by users or admins; agents get scoped OAuth 2.1 credentials; their actions are audit-distinguished from human actions.
- **G11.** Deployment to a fresh Ubuntu 24.04 VPS via `docker compose up -d` completes in under 30 minutes for Tier 1, including TLS provisioning.
- **G12.** Visual design is enterprise-clean, coherent across every plugin's surfaces, and recognizably Helix's identity (driven by the shadcn preset; see Section 11.1).

### 2.2 Success metrics (post-launch, internal dogfooding)

| Metric | Target |
|---|---|
| p95 mail-list render | < 200ms (with 10k messages indexed) |
| p95 search query | < 300ms across all entity types |
| Chat message delivery (sender → recipient) | < 150ms p95 in same region |
| Concurrent editors in one doc | 20+ without perceptible lag |
| Inbound mail accept → searchable | < 5s p95 |
| Outbound mail send → delivered (Gmail) | < 30s p95 |
| Jitsi call join time | < 4s from click to media |
| Plugin install → operational | < 30s for in-process plugins; < 2 min for external-service plugins |
| LLM routing decision overhead | < 5ms p95 |
| MCP tool catalog response | < 100ms |
| OTel trace ingestion lag | < 1s end-to-end |

### 2.3 Non-functional requirements

- **Availability target:** 99.5% for v1 Tier 1; 99.9% for Tier 3+ (HA topology required at this tier)
- **Data durability:** Postgres logical backups + WAL archiving to S3; RustFS versioning enabled; tested restore in CI nightly
- **Security:** TLS 1.3 only at edge; per-tier requirements detailed in Section 14
- **Privacy:** No outbound telemetry without explicit opt-in; logs scrubbed of message bodies; AI provenance tracked
- **Accessibility:** WCAG 2.2 AA; keyboard navigable; screen reader tested with NVDA and VoiceOver
- **Observability:** OpenTelemetry traces for every request, tool call, LLM call, and permission check
- **Agent-readiness:** Every API documented in OpenAPI 3.1; tool registry exposed via MCP; CLI covers all operations

---

## 3. Architecture overview

### 3.1 The cohesion principle

The single most important architectural decision is this: **all user-facing objects derive from a small shared set of primitives stored in one Postgres database.** Mail messages, chat messages, doc comments, calendar events, and file activity are all rows in a small set of platform-owned tables. Feature plugins compose those primitives; they do not introduce parallel storage.

This is what makes the experience cohesive by construction. There is no "mail database" and "chat database" to reconcile. A file referenced in mail and shared in chat is the same `objects` row — sharing widens permission, never copies the blob.

### 3.2 The platform principle

The cohesion primitives, the plugin SDK, the runtime, the configuration system, the agent surfaces, and the security/audit/observability backbone are the **platform**. Everything else — including mail, chat, drive, docs, calendar, meet, AI features, conversational assistant — is a **plugin**.

This means:

- The platform team (us) is also the first customer of the plugin SDK
- Any missing capability in the SDK gets fixed in the SDK, never worked around
- Every feature has a stable contract with the platform via the SDK
- Third-party plugins are first-class — they have the same access patterns as our own modules
- A deployment that doesn't need chat can simply not install the chat plugin; the schema knows nothing about chat in that case

### 3.3 System diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Vite SPA (one app, plugin-extensible)              │
│  Routes / panels / commands contributed by feature plugins via      │
│  the Web SDK (UI Capability). Shell, search palette, notifications, │
│  auth context, theme tokens are platform-owned.                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ tRPC over HTTPS + WSS
                               │ + REST (OpenAPI surface)
                               │ + MCP (agent surface)
                               │
                ┌──────────────▼──────────────────┐
                │   Helix app (Fastify, Node)      │
                │                                  │
                │   PLATFORM:                      │
                │   • Plugin host + SDK            │
                │   • Capability registries        │
                │   • Better-Auth (in-process)     │
                │   • Cerbos client                │
                │   • Config & tier engine         │
                │   • OpenAPI / MCP / CLI servers  │
                │   • Outbox + indexer + workers   │
                │   • OTel instrumentation         │
                │                                  │
                │   FIRST-PARTY PLUGINS:           │
                │   • core-mail (SMTP in/out)      │
                │   • core-chat (WS + presence)    │
                │   • core-drive                   │
                │   • core-docs (Yjs sync in-API)  │
                │   • core-calendar (CalDAV)       │
                │   • core-meet-jitsi              │
                │   • core-search-meilisearch      │
                │   • core-storage-rustfs          │
                │   • core-ai-routing              │
                │   • ai-provider-openai-compat    │
                │   • ai-provider-anthropic-compat │
                │   • ai-provider-bedrock          │
                │   • ai-provider-vertex           │
                │   • vector-pgvector              │
                │   • core-assistant (Helix AI)    │
                │   • core-cli                     │
                │   • core-mcp-server              │
                └──────────────┬───────────────────┘
                               │
       ┌───────────┬───────────┼───────────┬───────────┐
       │           │           │           │           │
  ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
  │Postgres │ │ RustFS  │ │  NATS   │ │Meilisrch│ │ Cerbos  │
  │+pgvector│ │ (S3 API)│ │JetStream│ │         │ │ (PDP)   │
  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
                               │
                  ┌────────────▼────────────┐
                  │ Jitsi Meet (v1 only)     │
                  │ → Mediasoup in v2        │
                  └──────────────────────────┘

  Tier-conditional add-ons (auto-provisioned by tier engine):
  • Tier 2+: Vault or SOPS, mTLS, encrypted backups, audit shipping
  • Tier 3+: SPIRE, KMS, HA Postgres, immutable audit, SIEM bridge
  • Tier 4: FIPS crypto adapters, STIG base images, air-gap install

  Edge: Caddy 2 (TLS, HTTP/3, reverse proxy)
  Outbound mail: nodemailer → SES / Mailgun / Postmark (SMTP relay)

  Optional observability stack (plugin: observability-grafana-stack):
  • Grafana + Tempo + Loki + Prometheus
```

### 3.4 Service and plugin responsibilities

| Component | Layer | Responsibility | Owns data? |
|---|---|---|---|
| **Vite SPA** | Platform UI | App shell, plugin loader for UI extensions, theme tokens, search palette, notification center | No |
| **Helix Node app** | Platform runtime | Fastify server, plugin host, capability registries, auth, config engine, workers | No |
| **Postgres** | Data | Source of truth: actors, objects, threads, messages, events, permissions, audit, Yjs snapshots | Yes |
| **RustFS / S3** | Data | Blob storage | Yes |
| **NATS JetStream** | Data | Event bus, durable streams | Yes (streams) |
| **Meilisearch** | Data | Search index (keyword) | Derived |
| **Cerbos** | Data | Policy evaluation (stateless; policies in `/policies/`) | No |
| **Redis** | Data | Sessions cache, rate limits, presence, ephemeral state | Ephemeral |
| **Jitsi** (v1) | External | WebRTC video | Yes (call state, ephemeral) |
| **Caddy** | Edge | TLS, reverse proxy, HTTP/3 | No |
| **First-party plugins** | Plugin | Each feature; uses platform SDK only | No (via platform tables) |

### 3.5 Cohesion mechanisms

**Single object model.** A file row, mail attachment, and chat upload are not independent entities. There is one `objects` table. A mail attachment is a `messages` row referencing an `objects` row. Sharing a file into chat creates a new `messages` row referencing the *same* `objects` row.

**Single principal model.** Humans and agents are both rows in `actors`. Every audit entry, every Cerbos check, every permission tuple references an `actor_id`. There is no separate "service account" table; service accounts are actors of `type='service_account'`. AI agents are actors of `type='agent'`. The system is non-human-aware from the ground up.

**Single permission model.** Every protected operation goes through `can(actor, action, resource)`. Cerbos evaluates YAML policies considering actor attributes (including `actor.type`, `actor.scopes`, `actor.parent_user_id` for delegated agents) and resource attributes. Policies live in `/policies/*.yaml`, version-controlled, code-reviewed.

**Single search index.** One Meilisearch index with a `type` facet. Plugins contribute indexers via the `IndexerCapability`; the platform routes events to them. Optional `VectorStore` plugin gives semantic ranking on top.

**Single notification bus.** NATS JetStream stream `notifications.*` is consumed by (a) WebSocket fan-out, (b) email digest, (c) mobile push (v2). Plugins emit notifications via the platform `Notifier` API.

**Single activity log.** Every mutation publishes to `activity.*` via the outbox pattern. The activity log feeds: search indexing, notifications, audit (with hash chain for tamper detection), agent provenance, and the user-visible "Activity" sidebar.

**Single observability spine.** Every request, tool call, LLM call, permission check, and external call produces an OpenTelemetry span with W3C Trace Context propagation. Spans correlate to `activity` rows by `trace_id`.

**Single agent surface.** Every meaningful action is a `Tool` in the platform's tool registry. The tool registry projects onto three protocols simultaneously: tRPC (for the SPA), OpenAPI/REST (for HTTP clients), and MCP (for agent frameworks). One source of truth, three projections.

**Protocols in-process.** SMTP receiving (`smtp-server`), Yjs sync (Fastify WebSocket), Better-Auth (library) all run inside the Helix Node app. No internal HTTP webhooks between mail, docs, auth, and the rest of the API. One process, one transaction, one log.

---

## 4. Plugin architecture

### 4.0 The confirmed model: core apps vs. connectors

**Helix v1 ships a confirmed two-part architecture. This section is normative and supersedes
any earlier wording that implied the seven core apps are plugins.**

- **Core apps** — mail, chat, drive, docs, calendar, meet, and the assistant — are
  **toggleable modules of the Helix platform**. They are *not* plugins and *not* per-user
  containers. They are wired directly into the Helix server, ship in one deployable by
  default, are multi-tenant, and scale by horizontal replicas.
  - An **org admin** can enable or disable any core app **globally** (default: all enabled)
    via the configuration system (`config.modules.<app>.enabled`, persisted in
    `platform_config`). A disabled core app is **not registered or served at all** — no
    routes, tools, event subscribers, indexers, or enrichments — and the web shell hides it
    and renders a clean "app disabled" state.
  - **Role-based boot** lets the *same image* run a subset of core apps. `HELIX_ROLE` (a
    named role) or `HELIX_APPS` (an explicit comma-separated app list) selects which enabled
    apps a process boots. The default role runs every enabled app; a role such as
    `HELIX_APPS=chat,meet` lets WebSocket-heavy apps run as their own Kubernetes Deployment +
    HPA of the same image. Module boundaries are kept clean so a future per-app image build
    is trivial. Each core app is refactored into a cohesive `register<App>Module()` boundary,
    invoked conditionally on its enablement + role.
  - Deployment stays simple: **docker-compose runs one all-in-one service**; **Helm runs one
    Deployment + HPA** by default, with the *option* to add extra Deployments of the same
    image parameterized by role (`roleDeployments` in the Helm values).

- **Add-on plugins** are **external connectors only** — integrations into *other* systems
  (MCP-style tools, inbound/outbound webhooks). The plugin SDK, the plugin loader, the
  `InProcessPluginRuntime`, the lifecycle hooks, and the namespaced migration runner
  described in the rest of this section are **reserved for these external connectors**. A
  connector is discovered from `/plugins`, validated, loaded, and started at server startup;
  its manifest declares `category: "connector"`. Core-app manifests declare
  `category: "core-app"` to keep the two cleanly separated in the manifest model.

The remainder of §4 (manifest, lifecycle, host API, namespacing, distribution) applies to
**add-on connector plugins**. Where it speaks of "first-party plugins" such as `core-mail`,
read that as the historical framing — those features are delivered as core-app platform
modules, not loadable plugins.

### 4.1 Why the plugin SDK still goes first

The connector SDK is the spine of Helix's extensibility story. The platform foundation —
cohesion primitives, capability registries, the SDK, configuration, and the security/audit
backbone — is built first so every core-app module and every external connector has a stable
contract with the platform. The platform team is the first customer of the SDK; any missing
capability gets fixed in the SDK, never worked around.

### 4.2 Plugin model

A plugin is a self-contained directory (under `/plugins/<id>/`) with:

```
plugins/com.helix.core.mail/
├── plugin.json              # manifest (JSON Schema validated)
├── package.json             # if it has runtime code
├── src/
│   ├── index.ts             # default export is the plugin definition
│   ├── server/              # platform-side code
│   │   ├── routes.ts        # contributes tRPC routes / REST endpoints
│   │   ├── tools.ts         # contributes Tools (agent registry)
│   │   ├── ingest.ts        # SMTP receiver (uses platform SDK)
│   │   ├── sender.ts        # SMTP sender
│   │   ├── filters.ts
│   │   └── policies.ts      # contributes Cerbos policy fragments
│   ├── web/                 # SPA-side code
│   │   ├── routes.tsx       # contributes routes to the shell
│   │   ├── panels.tsx       # contributes UI panels / suggestion slots
│   │   └── command-items.ts # contributes to the command palette
│   └── shared/              # shared types
├── migrations/              # namespace-prefixed (mail_*) Drizzle migrations
│   └── 0001_initial.sql
├── policies/                # Cerbos policies this plugin contributes
│   └── resources/
│       └── mail_thread.yaml
└── README.md
```

### 4.3 The manifest (`plugin.json`)

```json
{
  "id": "com.helix.core.mail",
  "name": "Mail",
  "version": "1.0.0",
  "description": "First-party mail feature: SMTP in/out, threading, labels, filters, vacation",
  "vendor": { "name": "Helix", "url": "https://helix.example.com" },
  "license": "Apache-2.0",
  "sdkVersion": "^1.0.0",

  "kind": "in-process",          // 'in-process' | 'external-service' | 'wasm' (v2)
  "main": "./src/index.ts",      // entry point for in-process plugins
  "endpoint": null,              // URL for external-service plugins

  "capabilities": {
    "provides": [
      "trpc-router:mail",
      "rest-endpoints:/mail/*",
      "smtp-listener:25,587",
      "tools:mail.*",
      "indexer:mail",
      "ui-route:/mail",
      "ui-panel:right-rail:thread-contacts",
      "command-palette:mail.*",
      "notification-source:mail.received"
    ],
    "consumes": [
      "storage",
      "search",
      "permissions",
      "notifier",
      "ai-routing",              // optional; will gracefully degrade if absent
      "vector-store"             // optional; for semantic search of mail
    ]
  },

  "permissions": {
    "scopes": ["mail.read", "mail.write", "mail.send", "mail.admin"],
    "outbound-network": ["smtp.amazonses.com:587", "smtp.mailgun.org:587"],
    "filesystem": [],
    "envVars": ["SMTP_RELAY_HOST", "SMTP_RELAY_USER", "SMTP_RELAY_PASS", "MAIL_FROM_DOMAIN"]
  },

  "migrations": "./migrations",
  "policies": "./policies",

  "uiContribution": {
    "shellRoutes": ["/mail"],
    "leftRailItem": { "label": "Mail", "icon": "mail", "order": 1 },
    "settingsPages": ["mail.filters", "mail.vacation", "mail.aliases"]
  },

  "tierRequirements": {
    "minTier": "personal",
    "tierRestrictions": {
      "sovereign": {
        "outbound-network": "explicit-allowlist-required",
        "notes": "Tier 4 deployments must use an on-prem SMTP relay; external SMTP relays prohibited"
      }
    }
  },

  "ai": {
    "suggestionSlots": [
      { "id": "mail.compose-help", "description": "Suggest body content while composing" },
      { "id": "mail.summarize-thread", "description": "Summarize a long thread" },
      { "id": "mail.suggest-reply", "description": "Suggest a short reply" }
    ],
    "enrichments": [
      { "id": "mail.entity-extract", "description": "Extract people, dates, action items" },
      { "id": "mail.classification", "description": "Tag with sensitivity classification" }
    ]
  }
}
```

The manifest is validated on install via the JSON Schema published in `@helix/sdk`. Plugins with invalid manifests are rejected; plugins whose declared capabilities aren't satisfied are loaded but marked `degraded` in the admin UI.

### 4.4 Plugin lifecycle

```
discovered → validated → installed → migrating → migrated → starting → enabled
                                                                    ↓
                                                              disabled → uninstalling → uninstalled
```

- **discovered:** present in `/plugins/` or `/plugins-installed/` (the dynamic install location)
- **validated:** manifest passed JSON Schema; declared SDK version compatible; dependencies satisfied
- **installed:** code loaded, migrations registered (not yet run)
- **migrating → migrated:** plugin migrations run (in a transaction, namespaced)
- **starting:** plugin's `onStart(host)` lifecycle hook called; subscriptions registered, routes mounted, tools registered, UI contributions exposed to web SDK
- **enabled:** fully operational; visible in UI; tools available; routes serving
- **disabled:** admin-disabled; code stays loaded, routes return 503, tools removed from registry, UI hidden, but no data deleted
- **uninstalling:** migrations marked for rollback (with admin confirmation); UI removed
- **uninstalled:** code unloaded; data optionally retained or purged per admin choice

Disabling a plugin should be safe and reversible. Uninstalling is admin-confirmed and may delete plugin-owned tables (after backup).

### 4.5 The platform host API

The host API is what the platform exposes to plugins via the `@helix/sdk` package. Plugins receive a `host` object in their lifecycle hooks:

```typescript
// /packages/sdk/src/host.ts
export interface PlatformHost {
  // Identity & current request
  readonly request: RequestContext;        // when inside a request handler
  readonly actor: Actor;                   // the calling principal
  readonly tracer: Tracer;                 // OTel tracer

  // Data access
  readonly db: DrizzleClient;              // namespaced; only see your tables + platform tables
  readonly storage: StorageClient;         // S3-compatible API
  readonly cache: CacheClient;             // Redis with key prefix
  readonly events: EventBus;               // NATS publish/subscribe with subject prefix

  // Authorization
  can(action: string, resource: ResourceRef): Promise<boolean>;
  requirePermission(action: string, resource: ResourceRef): Promise<void>;

  // Cross-plugin capabilities
  capabilities: {
    search: SearchCapability;
    notifier: NotifierCapability;
    ai: AICapability | null;               // null if no AI provider configured
    vectorStore: VectorStoreCapability | null;
    storage: StorageCapability;
    audit: AuditCapability;
  };

  // Plugin registration helpers
  registerTRPCRouter(routerKey: string, router: TRPCRouter): void;
  registerRESTEndpoint(path: string, handler: RESTHandler): void;
  registerTool(tool: ToolDefinition): void;
  registerWebSocketHandler(path: string, handler: WSHandler): void;
  registerIndexer(indexer: IndexerDefinition): void;
  registerNotificationSource(source: NotificationSource): void;
  registerScheduledJob(job: ScheduledJobDefinition): void;
  registerNATSConsumer(subject: string, handler: ConsumerHandler): void;
  registerSMTPListener(opts: SMTPListenerOpts, handler: SMTPHandler): void;
  registerSuggestionSlotProvider(slot: string, provider: SlotProvider): void;
  registerEnrichmentSource(id: string, handler: EnrichmentHandler): void;

  // Observability
  metric: MetricsClient;                   // Prometheus
  log: Logger;                             // pino, namespaced

  // Config (plugin-scoped)
  config: PluginConfig;                    // reads from /etc/helix/config.yaml#/plugins/<id>

  // Internationalization
  i18n: I18nClient;
}
```

The web-side SDK exposes a parallel `WebPlatformHost` with React-specific helpers:

```typescript
// /packages/sdk/src/web.ts
export interface WebPlatformHost {
  // Auth + user
  useSession(): Session;
  useActor(): Actor;

  // Data
  trpc: TRPCClient;
  queryClient: QueryClient;

  // UI registration
  registerShellRoute(route: ShellRoute): void;
  registerLeftRailItem(item: LeftRailItem): void;
  registerRightRailPanel(panel: PanelExtension): void;
  registerCommandPaletteItems(items: CommandItem[]): void;
  registerSettingsPage(page: SettingsPage): void;
  registerSuggestionSlot(slot: SuggestionSlotDef): void;
  registerPreviewRenderer(mime: string, renderer: PreviewRenderer): void;

  // Tokens & theme
  tokens: PresetTokens;                    // exposes shadcn preset's CSS variables typed
  colorMode: 'light' | 'dark' | 'system';
}
```

### 4.6 Plugin namespacing rules

To prevent collisions and make migration history clear, every plugin namespaces its artifacts:

- **Tables:** prefix with plugin short-name (`mail_*`, `chat_*`, `drive_*`). Platform tables have no prefix (`actors`, `objects`, `threads`, `messages`, `permissions`, `activity`).
- **NATS subjects:** prefix with plugin id (`com.helix.core.mail.received`)
- **Cache keys:** prefix with plugin id
- **Cerbos resource kinds:** prefix when needed (`mail_thread`, not `thread`); platform-shared kinds are unprefixed (`object`, `thread`, `event`)
- **Trace span names:** prefix with plugin id (`com.helix.core.mail.smtp.receive`)
- **Metric names:** prefix (`helix_mail_smtp_received_total`)

### 4.7 In-process vs. external-service plugins

**In-process** plugins (v1 default): TypeScript modules loaded into the Helix Node process. Fastest, simplest, most powerful. Trust model: same as core code. Use for first-party plugins and trusted enterprise extensions.

**External-service** plugins: declared by manifest with an HTTP/gRPC endpoint. Helix calls them; they respond. Use for:
- Language-specific code (Python ML pipelines, Java enterprise integrations)
- Resource-intensive operations (LLM inference, OCR, video transcoding)
- Third-party plugins where isolation matters
- Tier 3+ deployments that want process boundaries between concerns

The capability APIs are identical; only the transport differs. A plugin author can start in-process and lift to external-service later without changing the host-facing contract.

**WASM** plugins (v2): WIT-described interfaces with Wasmtime runtime. Best isolation, language-agnostic, in-process-fast. Designed-for in v1's capability shape; not implemented.

### 4.8 Plugin distribution and install

**Plugin sources:**
- **Bundled:** ship in the Helix Docker image at `/plugins/` (first-party plugins)
- **Sideloaded:** mount/copy to `/plugins-installed/` on the host
- **Registry:** install via `helix plugin install <id>@<version>` (v1.5; fetches from Helix's official registry or a self-hosted registry)
- **Local dev:** `pnpm helix dev` watches plugin sources and hot-reloads

**Install permissions prompt:** when an admin installs a plugin not from the official Helix registry, the admin UI shows the requested permissions, scopes, capabilities consumed, and outbound network endpoints. Install is blocked until each is confirmed.

**Signature verification:** v1.5 — Sigstore-signed plugin artifacts; verification required at higher tiers.

---

## 5. Configuration model

### 5.1 Sources of configuration

In precedence order (highest wins):

1. Environment variables (for secrets and bootstrap)
2. `/etc/helix/config.yaml` (or the path in `HELIX_CONFIG_PATH`)
3. Admin UI overrides (stored in Postgres `platform_config` table, hot-applied)
4. Plugin defaults (declared in each plugin's manifest)

### 5.2 Config schema (excerpted)

```yaml
# /etc/helix/config.yaml
helix:
  version: 1
  deployment:
    name: "Helix at example.com"
    domain: helix.example.com
    publicUrl: https://helix.example.com
    timezone: America/New_York
    locale: en-US

security:
  tier: business              # personal | business | enterprise | sovereign
  overrides:
    transit:
      mtlsInternal: true
      tls13Only: true
    rest:
      postgresEncryption: tde     # off | filesystem | tde | column
      objectStorageSSE: sse-s3    # off | sse-s3 | sse-kms | sse-c
      backupEncryption: age       # none | age | gpg | kms
    secrets:
      backend: sops             # env | sops | vault | aws-sm | gcp-sm | azure-kv
      rotation: 90d
    auth:
      mfaRequired: admins       # none | admins | all
      sessionDurationMaxHours: 24
      passkeyRequired: false
    audit:
      shipTo: ['s3-immutable', 'siem-syslog']
      hashChain: true
      retentionDays: 2555       # 7 years
    network:
      ipAllowlistAdmin: ["10.0.0.0/8", "192.168.0.0/16"]
      egressMode: allowlist     # open | allowlist
    fips:
      enabled: false            # tier 4 only

modules:
  mail:
    enabled: true
    plugin: "com.helix.core.mail@^1.0.0"
    config:
      mxDomain: helix.example.com
      smtpRelay:
        host: email-smtp.us-east-1.amazonaws.com
        port: 587
        user: ${SMTP_RELAY_USER}
        pass: ${SMTP_RELAY_PASS}
      undoSendSeconds: 30
      perUserSendQuota: { perHour: 200, perDay: 2000 }
  chat:
    enabled: true
    plugin: "com.helix.core.chat@^1.0.0"
  drive:
    enabled: true
    plugin: "com.helix.core.drive@^1.0.0"
  docs:
    enabled: true
    plugin: "com.helix.core.docs@^1.0.0"
  calendar:
    enabled: true
    plugin: "com.helix.core.calendar@^1.0.0"
  meet:
    enabled: true
    plugin: "com.helix.core.meet-jitsi@^1.0.0"   # swap to mediasoup later
    config:
      jitsiDomain: meet.helix.example.com
      jwtSecret: ${JITSI_JWT_SECRET}
  search:
    enabled: true
    plugin: "com.helix.core.search-meilisearch@^1.0.0"
    config:
      semantic: true            # only if a vector store + embedding provider are configured
  storage:
    enabled: true
    plugin: "com.helix.core.storage-rustfs@^1.0.0"
    config:
      endpoint: http://rustfs:9000
      bucket: helix
      region: us-east-1

ai:
  enabled: true
  defaultPosture: admin-controlled    # users inherit admin's enabled/disabled per-feature
  providers:
    - id: anthropic-prod
      plugin: "com.helix.ai-provider-anthropic-compat@^1.0.0"
      config:
        baseUrl: https://api.anthropic.com
        apiKey: ${ANTHROPIC_API_KEY}
        models: [claude-3-5-sonnet, claude-3-5-haiku]
    - id: bedrock-prod
      plugin: "com.helix.ai-provider-bedrock@^1.0.0"
      config:
        region: us-east-1
        models: [anthropic.claude-3-5-sonnet-20241022-v2:0]
    - id: vertex-prod
      plugin: "com.helix.ai-provider-vertex@^1.0.0"
      config:
        project: my-gcp-project
        location: us-central1
    - id: ollama-local
      plugin: "com.helix.ai-provider-openai-compat@^1.0.0"
      config:
        baseUrl: http://ollama:11434/v1
        apiKey: ""
        models: [llama3.1:70b, mistral:7b, nomic-embed-text]
  vectorStore:
    plugin: "com.helix.vector-pgvector@^1.0.0"   # default
    # alternatives: vector-qdrant, vector-milvus, vector-chroma, vector-weaviate
  embeddingProvider:
    plugin: "com.helix.embedding-openai-compat@^1.0.0"
    config:
      providerId: ollama-local
      model: nomic-embed-text
      dimensions: 768
  routing:
    rules:
      - feature: mail.compose-help
        primary: { providerId: anthropic-prod, model: claude-3-5-haiku }
        fallback: { providerId: ollama-local, model: llama3.1:70b }
        classifications: { restricted: { providerId: ollama-local } }
      - feature: docs.summarize
        primary: { providerId: bedrock-prod, model: anthropic.claude-3-5-sonnet-20241022-v2:0 }
      - feature: assistant.chat
        primary: { providerId: anthropic-prod, model: claude-3-5-sonnet }
  costLimits:
    perUserPerDayUSD: 5
    perOrgPerDayUSD: 500
  audit:
    logRequests: full           # off | metadata-only | full
    retainDays: 90
  privacy:
    redactPIIBeforeSend: true
    classificationGating: true
    blockExternalForClassifications: [confidential, restricted]

observability:
  enabled: true
  plugin: "com.helix.observability-otel@^1.0.0"
  config:
    otlpEndpoint: http://tempo:4317
    sampling:
      traces: 0.1
      llmCalls: 1.0           # always trace LLM calls
      toolCalls: 1.0
      permissionChecks: 0.05
  bundledStack:
    enabled: true             # provisions Grafana + Tempo + Loki + Prometheus
    plugin: "com.helix.observability-grafana-stack@^1.0.0"
    grafanaUrl: https://grafana.helix.example.com

agents:
  enabled: true
  mcpServer:
    enabled: true
    plugin: "com.helix.core-mcp-server@^1.0.0"
    publicUrl: https://helix.example.com/mcp
  openapi:
    enabled: true
    publicUrl: https://helix.example.com/openapi.json
  defaults:
    confirmationRequired:
      destructive: true
      external_communication: true
    rateLimits:
      perAgentPerMinute: 60
      perAgentPerDay: 5000
    costLimits:
      perAgentPerDayUSD: 10
    tokenLifetimeMinutes: 60
```

### 5.3 Admin UI

The admin UI in `/settings/admin` is a typed editor over this schema. Each section is a form generated from the config schema. Edits write to `platform_config` (Postgres) and hot-apply via NATS broadcast to all replicas.

Sensitive fields (API keys, secrets) are stored encrypted at rest with the platform encryption key (or via the configured secrets backend). The UI shows masked values; admins can rotate via the rotation flow.

### 5.4 Tier engine

The tier engine reads `security.tier` and `security.overrides`, then:

1. **Validates plugins against tier policies.** A plugin marked `tierRestrictions.sovereign: "prohibited"` cannot install in a Tier 4 deployment.
2. **Enforces tier defaults that aren't overridden.** If `security.overrides.transit.mtlsInternal` is unset, the tier engine fills it from the tier default.
3. **Provisions required sidecars.** Tier 3+ enables Vault sidecar, SPIRE agent, audit shipper. The admin UI shows a "tier requires these services to be running" panel with status.
4. **Refuses tier upgrades that would lose data.** Going from Personal → Business requires backup encryption; the tier engine refuses the upgrade until a successful encrypted backup completes.
5. **Allows tier downgrades only via explicit confirmation.** Downgrade may relax security; require admin acknowledgment.

The tier engine is itself implemented as a platform module, and the security tier table is part of the platform schema. Plugins query their effective tier via `host.config.tier`.

---

## 6. Technology stack (pinned)

These versions are the baseline. Patch versions are fine; major upgrades require a decision record.

### 6.1 Frontend

Frontend is **TanStack-first**. The SDK exposes plugin contribution points; first-party plugins ship UI via this SDK same as third-party plugins will.

```
node                            22.x LTS
pnpm                            9.x
vite                            6.x
react                           19.x
typescript                      5.6+

# TanStack — the spine of the frontend
@tanstack/react-router          latest      # file-based + plugin-registered routes, type-safe links
@tanstack/router-plugin         latest      # Vite plugin for codegen
@tanstack/router-devtools       latest
@tanstack/react-query           v5
@tanstack/query-devtools        v5
@tanstack/react-form            latest
@tanstack/react-table           v8
@tanstack/react-virtual         latest
@tanstack/store                 latest
@tanstack/pacer                 latest

# Styling
tailwindcss                     4.x
@tailwindcss/vite               4.x
shadcn (CLI)                    latest
lucide-react                    latest

# Editors / collaboration
@tiptap/react                   v2
@tiptap/pm                      v2
yjs                             v13
y-prosemirror                   latest
y-protocols                     latest

# Interaction
react-aria-components           latest
dnd-kit                         latest
framer-motion                   v11
cmdk                            latest
sonner                          latest

# Data + utilities
date-fns                        v4
zod                             v3
rrule                           latest

# RPC
@trpc/client                    v11
@trpc/react-query               v11

# Video
@jitsi/iframe-api               runtime-loaded

# Helix SDK
@helix/sdk-web                  workspace
@helix/sdk-types                workspace
```

### 6.2 Backend

```
node                            22.x LTS
fastify                         v5
@fastify/cors                   latest
@fastify/cookie                 latest
@fastify/websocket              latest
@fastify/multipart              latest
@fastify/rate-limit             latest
@fastify/under-pressure         latest
@fastify/swagger                latest        # OpenAPI 3.1 generation
@fastify/swagger-ui             latest        # /docs

@trpc/server                    v11
trpc-openapi                    latest        # tRPC → OpenAPI projection

# Auth
better-auth                     latest
@better-auth/cli                latest

# Data
drizzle-orm                     latest
drizzle-kit                     latest
postgres                        latest        # postgres-js
ioredis                         latest
nats.js                         latest
meilisearch                     JS client latest
pgvector                        node bindings

# Authorization
@cerbos/grpc                    latest

# Mail (in-process)
smtp-server                     latest
mailparser                      v3
nodemailer                      v6
mailauth                        latest

# Yjs sync (in-process)
yjs                             v13
y-protocols                     latest

# Calendar
ical-generator                  latest
ical.js                         latest
rrule                           latest

# Media
sharp                           latest
fluent-ffmpeg                   latest

# Agent surfaces
@modelcontextprotocol/sdk       latest        # MCP server
openapi-types                   latest

# Observability
@opentelemetry/sdk-node         latest
@opentelemetry/exporter-trace-otlp-http  latest
@opentelemetry/auto-instrumentations-node  latest
@opentelemetry/instrumentation-fastify   latest
@opentelemetry/instrumentation-pg        latest
@opentelemetry/instrumentation-ioredis   latest
@opentelemetry/instrumentation-undici    latest
prom-client                     latest        # Prometheus metrics

# Logging
pino                            v9
pino-pretty                     latest        # dev only

# Utilities
zod                             v3
argon2                          latest        # app passwords + audit hash chain
nanoid                          latest

# Helix SDK
@helix/sdk                      workspace
@helix/sdk-types                workspace
```

### 6.3 Infrastructure (Docker images by tier)

**Tier 1 (Personal) — 7 core services:**

```
postgres:17-alpine                              with pgvector extension
redis:7-alpine
nats:2.10-alpine                                with JetStream
getmeili/meilisearch:v1.10
rustfs/rustfs:latest
ghcr.io/cerbos/cerbos:latest
ghcr.io/helix/helix:latest                      THIS REPO
caddy:2-alpine                                  edge proxy
```

**Tier 2 (Business) adds:**

```
ghcr.io/getsops/sops:latest                     or vault:latest if Vault chosen
ghcr.io/helix/audit-shipper:latest              ships audit to immutable S3
grafana/grafana:latest                          (via observability-grafana-stack plugin)
grafana/tempo:latest
grafana/loki:latest
prom/prometheus:latest
prom/node-exporter:latest
```

**Tier 3 (Enterprise) adds:**

```
hashicorp/vault:latest                          (mandatory at this tier)
ghcr.io/spiffe/spire-server:latest              (SPIFFE/SPIRE for mTLS service identity)
ghcr.io/spiffe/spire-agent:latest
ghcr.io/cloudnative-pg/postgres:latest          (HA Postgres operator)
qdrant/qdrant:latest                            (or milvus etc., if not pgvector)
```

**Tier 4 (Sovereign) adds:**

```
# All base images switch to FIPS-validated equivalents (e.g., Chainguard's FIPS images
# or Iron Bank STIG-hardened images)
# Crypto adapters use FIPS providers; spec'd, implementation post-v1
```

**Meet subsystem (separate compose project):**

```
jitsi/web, jitsi/prosody, jitsi/jicofo, jitsi/jvb
```

### 6.4 External services (production)

- **DNS:** Cloudflare, Route 53, or self-hosted
- **Outbound email:** AWS SES (primary), Mailgun/Postmark (failover)
- **Object storage:** RustFS for self-host; AWS S3 / Cloudflare R2 / Backblaze B2 in cloud (all S3-compatible)
- **TLS:** Let's Encrypt via Caddy
- **Backup target:** S3 with Object Lock; Backblaze B2 with versioning; or local with `restic` to a remote
- **AI providers:** any combination of OpenAI-compatible endpoints (OpenAI, Azure OpenAI, Ollama, vLLM, Groq, Together, etc.) and Anthropic-compatible endpoints (Anthropic, Bedrock, Vertex)

---

## 7. Capability catalog

Capabilities are the typed extension points the platform exposes to plugins. Each is a TypeScript interface in `@helix/sdk` with a stability contract. Plugins implement capabilities they `provide` and consume capabilities they require.

### 7.1 Platform-owned capabilities (provided by core)

These are implemented by the platform; plugins consume them.

| Capability | Interface | Owner | Used by |
|---|---|---|---|
| `Auth` | sign in/up, sessions, app passwords, OAuth client creds | platform | every plugin |
| `Permissions` | `can(actor, action, resource)` via Cerbos | platform | every plugin |
| `Storage` | S3-compatible object storage | platform (delegates to storage plugin) | drive, mail, meet, drive-derived previews |
| `Search` | unified index; per-plugin indexer registration | platform | every searchable plugin |
| `VectorStore` (optional) | upsert/query/delete vectors | platform (delegates to vector plugin) | AI features, semantic search |
| `Notifier` | emit notification → multi-channel fan-out | platform | mail, chat, drive, calendar, docs |
| `EventBus` | NATS publish/subscribe with namespace | platform | every plugin |
| `Audit` | append immutable activity record | platform | every plugin (auto on mutations) |
| `Outbox` | atomic event publishing | platform | every plugin |
| `Tracer`, `Logger`, `Metrics` | OTel + Pino + Prometheus | platform | every plugin |
| `Config` | typed config access scoped to plugin | platform | every plugin |
| `Tools` | register agent-callable tools | platform | every plugin |
| `MCPServer` | exposes tool registry as MCP | platform | (consumed by external agents) |
| `OpenAPISpec` | exposes routes as OpenAPI 3.1 | platform | (consumed by HTTP clients) |

### 7.2 Plugin-providable capabilities (extension points)

These are interfaces plugins implement to extend the system.

#### 7.2.1 Routing & UI

```typescript
interface RouteContribution {
  path: string;                       // '/mail/$threadId'
  component: ComponentType;
  loader?: RouteLoader;
  searchSchema?: z.ZodSchema;
}

interface LeftRailItem {
  label: string;
  icon: IconName;
  order: number;
  route: string;
  badge?: () => Promise<number>;     // unread counts etc.
}

interface RightRailPanelExtension {
  id: string;
  appliesTo: (route: string, ctx: PanelContext) => boolean;
  render: ComponentType<{ ctx: PanelContext }>;
  defaultOpen?: boolean;
}

interface CommandPaletteItem {
  id: string;
  title: string;
  keywords: string[];
  group: string;
  perform: (ctx: CommandContext) => void | Promise<void>;
  shortcut?: KeyChord;
}

interface SettingsPage {
  id: string;
  section: 'account' | 'workspace' | 'admin';
  path: string;
  title: string;
  component: ComponentType;
  permission?: string;
}

interface PreviewRenderer {
  mimePatterns: string[];             // ['application/pdf', 'image/*']
  component: ComponentType<{ object: PlatformObject; sized: 'thumb' | 'full' }>;
  priority?: number;
}
```

#### 7.2.2 Domain extension points

```typescript
interface ToolDefinition {
  id: string;                         // 'mail.send', 'drive.share'
  description: string;
  inputSchema: z.ZodSchema;           // generates JSON Schema for OpenAPI + MCP
  outputSchema: z.ZodSchema;
  permission: string;                 // routed through Cerbos
  sideEffects: 'read' | 'write' | 'destructive' | 'external_communication';
  confirmationRequired?: boolean;     // default: based on side-effect + tier
  rateLimit?: RateLimitSpec;
  handler: (input, ctx: ToolContext) => Promise<unknown>;
}

interface IndexerDefinition {
  id: string;                         // 'mail-indexer'
  entityType: string;                 // 'mail'
  subjects: string[];                 // NATS subjects to subscribe to
  project: (event: ActivityEvent, host: PlatformHost) => Promise<IndexDoc | null>;
}

interface NotificationSource {
  id: string;                         // 'mail.received'
  templates: NotificationTemplates;
  preferences: NotificationPrefSchema;
}

interface ScheduledJobDefinition {
  id: string;
  schedule: string;                   // cron or '@every 5m'
  leaderOnly: boolean;                // run only on the leader replica
  handler: (host: PlatformHost) => Promise<void>;
}

interface SMTPListenerOpts {
  ports: number[];                    // [25, 587]
  hostname: string;
  tls?: TLSOpts;
  auth?: SMTPAuthMode;
}
```

#### 7.2.3 Backend-swap capabilities

Each of these has multiple first-party implementations. The admin picks which plugin provides the capability in their deployment.

```typescript
interface StorageProvider {
  id: string;                         // 'rustfs', 's3', 'r2', 'b2'
  putObject(key: string, body: Stream, opts: PutOpts): Promise<PutResult>;
  getObject(key: string, opts?: GetOpts): Promise<ObjectStream>;
  getSignedUrl(key: string, op: 'GET' | 'PUT', expiresIn: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
  copyObject(src: string, dst: string): Promise<void>;
  listObjects(prefix: string, opts?: ListOpts): AsyncIterable<ObjectListing>;
}

interface AuthProvider {
  id: string;                         // 'better-auth', 'zitadel', 'keycloak'
  mode: 'local' | 'federated';         // federated providers bridge into Helix sessions
  signIn(credentials): Promise<Session>;
  verifySession(token): Promise<Actor | null>;
  refreshSession(refresh): Promise<Session>;
  ...
}

interface SearchEngine {
  id: string;                         // 'meilisearch', 'typesense', 'elasticsearch'
  upsert(docs: IndexDoc[]): Promise<void>;
  query(req: SearchRequest): Promise<SearchResponse>;
  delete(ids: string[]): Promise<void>;
}

interface VectorStore {
  id: string;                         // 'pgvector', 'qdrant', 'milvus', 'chroma', 'weaviate'
  createCollection(name: string, dim: number, metric: VectorMetric): Promise<void>;
  upsert(collection: string, items: VectorItem[]): Promise<void>;
  query(collection: string, vec: number[], opts: VectorQueryOpts): Promise<VectorMatch[]>;
  delete(collection: string, ids: string[]): Promise<void>;
}

interface VideoBackend {
  id: string;                         // 'jitsi', 'mediasoup', 'livekit'
  createRoom(opts: RoomOpts): Promise<Room>;
  mintJoinCredential(roomId: string, actor: Actor): Promise<JoinCredential>;
  endRoom(roomId: string): Promise<void>;
}

interface SecretsBackend {
  id: string;                         // 'env', 'sops', 'vault', 'aws-sm', 'gcp-sm', 'azure-kv'
  get(key: string): Promise<string>;
  set(key: string, value: string, opts?: SetOpts): Promise<void>;
  rotate(key: string): Promise<RotationResult>;
}

interface AuditDestination {
  id: string;                         // 'postgres', 's3-immutable', 'syslog', 'splunk', 'qradar'
  ship(events: AuditEvent[]): Promise<void>;
}

interface ObservabilityExporter {
  id: string;                         // 'otlp', 'datadog', 'honeycomb', 'newrelic'
  configure(opts: ExporterOpts): void;
}
```

### 7.3 AI capabilities (separated because there are many of them)

```typescript
interface LLMProvider {
  id: string;                         // 'anthropic-prod', 'openai-prod', 'ollama-local'
  protocol: 'openai-compatible' | 'anthropic-compatible' | 'bedrock' | 'vertex';
  chat(req: ChatRequest, ctx: AICallContext): Promise<ChatResponse> | AsyncIterable<ChatChunk>;
  models(): Promise<ModelInfo[]>;
  countTokens(text: string, model: string): Promise<number>;
}

interface EmbeddingProvider {
  id: string;
  embed(texts: string[], opts: EmbedOpts): Promise<number[][]>;
  dimensions(model?: string): number;
  maxBatchSize: number;
}

interface Reranker {
  id: string;                         // 'cohere', 'voyage', 'bge-local'
  rerank(query: string, documents: RerankDoc[], topK: number): Promise<RerankResult[]>;
}

interface TranscriptionProvider {
  id: string;                         // 'whisper-local', 'deepgram', 'assemblyai'
  transcribe(audio: Stream, opts: TranscribeOpts): Promise<Transcript>;
  streamTranscribe(audio: AsyncIterable<Buffer>): AsyncIterable<TranscriptChunk>;
}

interface OCRProvider {
  id: string;                         // 'tesseract', 'textract', 'doc-ai', 'azure-di'
  recognize(image: Buffer | Stream, opts: OCROpts): Promise<OCRResult>;
}

interface VisionProvider {
  id: string;                         // often piggybacks on multimodal LLMProvider
  describe(image: Buffer | URL, opts: VisionOpts): Promise<VisionResult>;
}

interface TextToSpeechProvider {
  id: string;
  synthesize(text: string, opts: TTSOpts): Promise<AudioBlob>;
}

interface SuggestionSlotProvider {
  slotId: string;                     // 'mail.compose-help', 'docs.smart-write'
  available(ctx: SlotContext): Promise<boolean>;
  generate(ctx: SlotContext): AsyncIterable<SuggestionChunk>;
}

interface EnrichmentHandler {
  id: string;                         // 'mail.summarize', 'meet.transcribe'
  triggers: string[];                 // NATS subjects
  produce: (event, host: PlatformHost) => Promise<Enrichment | null>;
}

interface MemoryStore {
  id: string;                         // 'per-user-pgvector'
  recall(actor: Actor, query: string, k: number): Promise<MemoryItem[]>;
  store(actor: Actor, item: MemoryInput): Promise<MemoryItem>;
  forget(actor: Actor, criteria: ForgetCriteria): Promise<number>;
}
```

---

## 8. AI capability layer

### 8.1 Design principles

**AI is a set of plugin capabilities, not a special subsystem.** Same SDK, same lifecycle, same tier enforcement, same audit, same observability. The AI section is long because there are *many* AI capabilities, not because AI is architecturally special.

**Three independent dimensions**:
1. **Provider protocol** (OpenAI-compatible, Anthropic-compatible, Bedrock, Vertex)
2. **What runs on it** (chat completion, embedding, transcription)
3. **What the platform does with the result** (suggest, enrich, retrieve, act)

**Five integration patterns** in feature plugins:
1. **Suggestion slots** — UI surfaces where AI can contribute (compose-help, summarize, smart-reply)
2. **Enrichments** — event-driven background processing (auto-categorize mail, transcribe recordings)
3. **Semantic search** — vector-based retrieval over the unified index
4. **Tool use (agentic)** — LLM invokes platform tools through the tool registry
5. **Conversational** — the Helix Assistant, a chat-style surface that uses tools

### 8.2 Provider protocols (the abstraction)

Every LLM provider implements the `LLMProvider` interface with one of four protocols:

#### 8.2.1 `openai-compatible`

Covers: OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, LocalAI, Groq, Together AI, Fireworks, DeepSeek, Mistral, OpenRouter, LiteLLM proxies, Anyscale, custom corporate gateways.

Configuration: `baseUrl`, `apiKey`, `models[]`. That's it. New OpenAI-compatible endpoints don't need a new plugin — just a new provider instance.

#### 8.2.2 `anthropic-compatible`

Covers: Anthropic direct API. Bedrock and Vertex use this *shape* but wrap it in their auth, so they get dedicated plugins.

Configuration: `baseUrl`, `apiKey`, `models[]`, `betaHeaders[]` (for prompt caching, etc.).

#### 8.2.3 `bedrock`

AWS Bedrock with SigV4 authentication and the Bedrock URL structure. Wraps Anthropic-compatible model invocations under the Bedrock API surface.

Configuration: `region`, AWS credentials (via IAM role, profile, or static), `models[]`.

#### 8.2.4 `vertex`

Google Cloud Vertex AI with GCP service account auth. Wraps Anthropic-compatible model invocations under Vertex.

Configuration: `project`, `location`, service account JSON (or workload identity), `models[]`.

### 8.3 Platform-managed routing

Feature plugins **do not pick providers or models directly**. They request an LLM call by feature id:

```typescript
const result = await host.capabilities.ai.chat({
  feature: 'mail.compose-help',
  messages: [...],
  tools: [...],                       // platform filters to those the actor can call
  classification: 'standard',         // overrides default based on resource
  actor: ctx.actor,
});
```

The routing service consults the `ai.routing.rules` config:

1. Find the rule matching `feature`
2. Check the input's `classification` and any tier policies
3. Select the primary provider+model
4. If the call fails or times out, try fallback
5. Record the routing decision in the span attributes
6. Account the cost against the actor's quota

The result: admin picks "fast/cheap for compose-help, smart/cheap for summarization, strongest for assistant" once, and all feature plugins benefit. Replacing a provider is one config line; no plugin code changes.

### 8.4 Data classification

Every protected resource can carry a classification tag: `public | standard | confidential | restricted`.

- **public:** can be processed by any provider, including external
- **standard:** default; subject to admin allowlist
- **confidential:** only providers tagged `internal-allowed-for-confidential`
- **restricted:** only providers tagged `air-gapped` or `local-only` (typically Ollama, vLLM, local)

Classification can be:
- **Explicit:** user/admin sets via UI
- **Label-derived:** mail labels like "Confidential" map to classification
- **Folder-derived:** files in `/HR/Restricted/` inherit
- **Heuristic:** content scanning (Tier 3+ feature) — e.g., presence of PII patterns elevates classification

The routing service refuses to send classified content to providers that don't meet the bar. Result is logged.

### 8.5 Tool-use registry (agentic primitive)

Every meaningful platform action is a `Tool`. The tool registry powers three surfaces simultaneously:

- The LLM tool-use surface (for in-Helix AI features)
- The MCP server (for external agents)
- The OpenAPI/REST surface (for HTTP clients)

Tool example:

```typescript
host.registerTool({
  id: 'mail.send',
  description: 'Send an email on behalf of the user',
  inputSchema: z.object({
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().max(998),
    bodyText: z.string(),
    bodyHtml: z.string().optional(),
    attachments: z.array(z.object({ objectId: z.string().uuid() })).optional(),
  }),
  outputSchema: z.object({
    messageId: z.string(),
    queuedAt: z.string().datetime(),
  }),
  permission: 'mail.send',
  sideEffects: 'external_communication',
  confirmationRequired: true,
  rateLimit: { perActor: { perHour: 60, perDay: 200 } },
  async handler(input, ctx) {
    await ctx.requirePermission('mail.send');
    // ... create messages row, queue outbox, return
  },
});
```

The platform automatically:
- Adds the tool to the OpenAPI spec at `/mail/send` (POST)
- Lists it in the MCP server's `tools/list` response
- Makes it available to LLM tool calls when `mail.send` is in the actor's permitted set
- Enforces confirmation requirement (queues the call, notifies the actor, waits for approval)
- Applies rate limits
- Tracks cost (tokens for the originating LLM call + any quota for the action itself)
- Audit-logs the invocation with `trace_id` for cross-system correlation

### 8.6 Semantic search

When a `VectorStore` provider is configured and an `EmbeddingProvider` is configured, the search plugin (`core-search-meilisearch`) augments its results with semantic ranking:

1. On indexing: every document gets keyword indexed in Meilisearch *and* embedded → stored in vector store
2. On query: hybrid retrieval — keyword recall from Meili + vector recall, blended by rank fusion (RRF)
3. Optional reranking: if a `Reranker` is configured, top-K from hybrid recall is reranked before display

If no vector store / embedding provider is configured, the search plugin degrades to keyword-only. No errors, no missing UI.

### 8.7 The Helix Assistant (`com.helix.core-assistant`)

A first-party plugin that provides a conversational AI surface:

- **UI:** a right-rail panel + a full-page route `/assistant`. Tiptap-based chat history, message bubbles, citation chips for retrieved context, tool-call cards showing what the assistant is about to do (with confirm/cancel buttons for destructive actions).
- **Backend:** orchestrates LLM calls (via routing service), tool calls (via tool registry), and context retrieval (via search + memory).
- **Provenance:** every assistant response is provenance-tagged (provider, model, tools called, sources retrieved); user can click to see the trail.
- **Memory:** opt-in per-user memory using `MemoryStore` capability — recalls relevant past interactions, can be cleared by the user.

The assistant is itself a tool consumer; it has no privileged access. It can only do what the user can do. Confirmation gates apply to it like to any other agent.

### 8.8 AI provenance, reversibility, and scope

Three baked-in principles enforced by the platform:

**Provenance.** Every AI-generated artifact carries metadata: which provider, model, version, prompt hash, timestamp, originating actor, originating feature. Stored in `ai_artifacts` table and displayed in UI as a small "AI-assisted" badge. Click reveals details.

**Reversibility.** Every enrichment can be deleted by the user (per-item, per-feature, or globally). "Forget what you know about me" deletes all `memory_items` rows for the actor. Activity log retains the deletion event (so admins can prove it was honored).

**Scope.** AI tool calls go through Cerbos like any other access. The AI cannot bypass permissions, cannot reach cross-actor data, cannot exfiltrate via tool calls (rate-limited, classification-gated, confirmation-required for `external_communication` tools).

### 8.9 Tier interactions for AI

| Tier | AI default constraints |
|---|---|
| Personal | Any configured provider; no classification gating; user responsibility |
| Business | Admin-allowlisted providers; classification gating enabled by default; per-user cost limits |
| Enterprise | Local providers preferred; cloud providers require BAA/DPA contractually; per-feature opt-in; PII redaction before send; audit logging full |
| Sovereign | Local providers only (Ollama, vLLM, llama.cpp); no external network; FIPS-validated embeddings; no third-party AI plugins permitted; air-gap-compatible plugin manifests |

---

## 9. Agent surfaces

### 9.1 The actors model

Every principal in Helix is an `actors` row. Replaces the v1.2 model where `users` was the only actor table.

```sql
actors (
  id              uuid primary key,
  type            text not null,          -- 'user' | 'service_account' | 'agent' | 'system'
  parent_user_id  uuid references actors(id),   -- for agents owned by a user
  parent_org_id   uuid,                         -- for org-owned service accounts
  display_name    text not null,
  description     text,
  email           text unique,                  -- for users; null otherwise
  avatar_object_id uuid references objects(id),
  created_by      uuid references actors(id),
  created_at      timestamptz default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  metadata        jsonb default '{}'
)
create index on actors (type);
create index on actors (parent_user_id);
```

Better-Auth's user records reference `actors` with `type='user'`. The platform's `users` table from v1.2 becomes a view over `actors WHERE type='user'`.

### 9.2 Credentials

```sql
agent_credentials (
  id                uuid primary key,
  actor_id          uuid references actors(id) not null,
  credential_type   text not null,           -- 'oauth_client' | 'api_key' | 'mtls_cert'
  client_id         text unique not null,    -- OAuth client_id for client-credentials flow
  secret_hash       text,                    -- argon2id; null for mtls_cert
  cert_fingerprint  text,                    -- for mtls_cert
  scopes            text[] not null,         -- ['mail.read', 'drive.write:shared']
  expires_at        timestamptz,
  rate_limit_overrides jsonb default '{}',
  ip_allowlist      cidr[],                  -- optional
  allowed_hours     jsonb,                   -- {tz, days, startHour, endHour}
  confirmation_override jsonb,               -- override default confirmation policy
  created_by        uuid references actors(id),
  created_at        timestamptz default now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  metadata          jsonb default '{}'
)
create index on agent_credentials (client_id) where revoked_at is null;
create index on agent_credentials (actor_id);
```

### 9.3 OAuth 2.1 client credentials flow

Agents authenticate via standard OAuth 2.1 client credentials:

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<id>
&client_secret=<secret>
&scope=mail.read mail.send drive.read
```

Response is a short-lived access token (default 1 hour, configurable per tier). The token is presented as `Authorization: Bearer <token>` on subsequent calls.

For MCP clients that prefer it, the token can be obtained via a click-through OAuth flow (Authorization Code) with the user approving scopes — useful for personal AI assistants where the user grants access interactively.

### 9.4 The OAuth scope catalog

Scopes are the named permissions agents request. Granular by design:

```
# Read
mail.read              read own mail
mail.read:shared       read mail shared via labels
drive.read             read own files
drive.read:shared      read files shared with the actor
chat.read              read chat the actor participates in
calendar.read          read own calendars
calendar.read:freebusy read only busy/free of others (not details)

# Write
mail.send              send mail
mail.write             modify mail (label, archive, delete own)
drive.write            create/upload files (in actor's own scope)
drive.write:shared     edit files where actor has 'editor'
chat.post              post to rooms actor is in
chat.create            create new rooms / DMs
calendar.write         create/edit own events
calendar.write:respond respond to invitations only

# Destructive
mail.delete            permanent delete
drive.delete           permanent delete

# External communication
mail.external          send to recipients outside the org

# Admin
admin.users            manage users
admin.config           change platform config
admin.audit            view audit log
admin.plugins          install/remove plugins

# Meta
profile.read           read actor's own profile + settings
profile.write          modify settings
```

Scopes compose: `mail.send + mail.external` is required to send to external recipients. The Cerbos policies enforce these compositions.

### 9.5 The MCP server

A first-party plugin (`com.helix.core-mcp-server`) implements the Model Context Protocol server interface. It:

- Lists all tools the authenticated actor can call (filtered by scopes + Cerbos)
- Exposes resources (read-only entity references the agent can read: a thread, a doc, a file)
- Handles tool invocations by routing to the tool registry
- Supports streaming for long-running calls
- Negotiates capabilities (auth, sampling, resources, tools) per MCP spec

The MCP endpoint is at `/mcp` and supports both stdio (for local dev) and HTTP+SSE (for remote MCP clients). Auth via OAuth 2.1 bearer token.

Once configured in an MCP client (Claude Desktop, OpenHands, Goose, Cursor, etc.), the agent sees Helix's full tool catalog and can invoke any tool the credential is scoped for.

### 9.6 OpenAPI 3.1 generation

The `core-openapi` plugin generates an OpenAPI 3.1 spec from:

- Fastify route definitions
- Tool registry entries (every tool also becomes a REST endpoint at `POST /tools/<id>`)
- Authentication schemes (Bearer, OAuth Client Credentials flow advertised)

The spec is served at `/openapi.json` and `/openapi.yaml`. Swagger UI (or Scalar) is mounted at `/docs`. Postman/Insomnia/HTTPie all consume this natively.

Spec includes:

- All endpoints with full schemas (request, response, errors)
- Security schemes (OAuth 2.1 client credentials, session cookie, app password Basic auth)
- Tag-grouped endpoints by plugin (mail, chat, drive, ...)
- Examples per endpoint
- Error response shapes

### 9.7 AsyncAPI for events

Plugins that emit events publish an AsyncAPI 3.0 spec fragment to the platform; the platform aggregates them at `/asyncapi.json`. Agents that want to react to events (new mail, file shared, etc.) read this spec to know what subjects to subscribe to and what payloads to expect.

Event delivery mechanisms:
- **WebSocket subscription** at `/events/ws` with subject filter and OAuth bearer token (for agents already maintaining a connection)
- **Webhook delivery** at admin-configured URLs (for agents that prefer push)

### 9.8 The CLI (`helix`)

A first-party plugin `core-cli` builds a CLI from the same OpenAPI spec. Implemented in TypeScript, distributed as an npm package and as standalone binaries (via `pkg` or `bun build --compile`).

```
helix login --client-id ... --client-secret ...
helix mail send --to alice@example.com --subject "Hi" --body "Hello"
helix drive upload ./report.pdf --folder Reports
helix search "project zenith"
helix tool list
helix tool call mail.send --json '{...}'
helix mcp serve                          # run as local MCP server
helix plugin list
helix plugin install <id>@<version>
helix tier set business
helix backup create
helix restore --from <backup-id>
```

Every meaningful platform operation has a CLI verb. The CLI auto-completes from the OpenAPI spec. CLI commands emit OTel traces if `HELIX_TRACE_TOKEN` is set, so admin-initiated ops appear in the same observability stack as everything else.

### 9.9 Confirmation flow for destructive / external tool calls

When an agent calls a tool requiring confirmation:

1. Platform creates a `pending_actions` row, returns `requires_confirmation: true` with an `action_id`
2. Sends notification to the agent's `parent_user_id` (or all admins for org-owned agents): "Agent X wants to do Y. Approve?"
3. Notification appears in web UI, mobile (v2), and email (if configured)
4. User approves → action runs synchronously, agent gets result; or denies → action rejected
5. Timeout after configurable interval (default 10 min) → auto-denied
6. All states logged to audit

The agent can poll `GET /actions/<id>` to check status, or subscribe via WebSocket.

### 9.10 Per-agent rate and cost limits

Per agent and per tier, configurable defaults:

| Limit | Personal | Business | Enterprise | Sovereign |
|---|---|---|---|---|
| Requests/minute | unlimited | 60 | 60 | 30 |
| Requests/day | unlimited | 5,000 | 5,000 | 1,000 |
| LLM cost/day USD | unlimited | $10 | $50 | $0 (local only) |
| Token credential lifetime | 4h | 1h | 1h | 15min |
| `external_communication` requires confirm | configurable | yes | yes | always |

Limits are enforced via Redis sliding window. Exceeding limits returns 429 with `Retry-After`. Cost limits send a notification to the owner when 80% is reached, hard-stop at 100%.

---

## 10. Domain model (platform schema)

The platform owns a small set of tables. Plugin migrations add namespaced tables on top.

### 10.1 Core platform tables

```typescript
// actors — every principal (humans, service accounts, agents, system)
actors {
  id: uuid primary key
  type: text not null                       // 'user' | 'service_account' | 'agent' | 'system'
  parent_user_id: uuid references actors(id)
  parent_org_id: uuid
  display_name: text not null
  description: text
  email: text unique                        // for users
  avatar_object_id: uuid references objects(id)
  created_by: uuid references actors(id)
  created_at: timestamptz
  last_used_at: timestamptz
  revoked_at: timestamptz
  metadata: jsonb default '{}'
}

// Better-Auth tables (account, session, verification) link to actors via user_id

// agent_credentials — see 9.2

// objects — universal blob+metadata table
objects {
  id: uuid primary key
  owner_actor_id: uuid references actors(id) not null
  kind: text not null                       // 'file' | 'attachment' | 'avatar' | 'recording' | 'thumbnail'
  mime_type: text not null
  size_bytes: bigint not null
  storage_key: text not null
  content_hash: text not null
  thumbnail_object_id: uuid references objects(id)
  classification: text default 'standard'
  metadata: jsonb default '{}'
  created_at: timestamptz
  deleted_at: timestamptz
}
create unique index on objects (owner_actor_id, content_hash) where deleted_at is null;
create index on objects (classification);

// threads — used by mail, chat rooms, doc comment threads, calls, file comments
threads {
  id: uuid primary key
  channel: text not null                    // 'mail' | 'chat_room' | 'chat_dm' | 'doc_comments' | 'file_comments' | 'call'
  subject: text
  parent_object_id: uuid                    // for doc/file comment threads
  encryption_mode: text default 'server_visible'  // 'server_visible' | 'e2ee'  (forward-compat for v1.5+)
  classification: text default 'standard'
  created_by: uuid references actors(id)
  created_at: timestamptz
  updated_at: timestamptz
  last_message_at: timestamptz
  metadata: jsonb default '{}'
}

// thread_participants
thread_participants {
  thread_id: uuid references threads(id)
  actor_id: uuid references actors(id)
  role: text not null                       // 'owner' | 'member' | 'guest'
  joined_at: timestamptz
  last_read_at: timestamptz
  notification_pref: text default 'all'
  primary key (thread_id, actor_id)
}

// messages — mail messages, chat messages, comments
messages {
  id: uuid primary key
  thread_id: uuid references threads(id) not null
  sender_actor_id: uuid references actors(id)
  sender_email: text                        // for external mail senders
  body_text: text
  body_html: text
  body_yjs: bytea
  reply_to_message_id: uuid references messages(id)
  classification: text default 'standard'
  ai_generated: boolean default false       // provenance flag
  ai_provenance_id: uuid                    // ref to ai_artifacts row
  created_at: timestamptz
  edited_at: timestamptz
  deleted_at: timestamptz
  metadata: jsonb default '{}'
}

// message_attachments
message_attachments {
  message_id: uuid references messages(id)
  object_id: uuid references objects(id)
  display_name: text not null
  position: int not null
  inline: boolean default false
  primary key (message_id, object_id)
}

// permissions — grants for the can() function
permissions {
  id: uuid primary key
  resource_type: text not null              // 'object' | 'thread' | 'calendar' | 'event' | ...
  resource_id: uuid not null
  principal_type: text not null             // 'user' | 'agent' | 'org' | 'link_token'
  principal_id: text not null               // actor_id for user/agent; org_id for org; token for link
  role: text not null                       // 'owner' | 'editor' | 'viewer' | 'commenter' | 'participant'
  granted_by_actor_id: uuid references actors(id)
  granted_at: timestamptz
  expires_at: timestamptz
}
create index on permissions (resource_type, resource_id);
create index on permissions (principal_type, principal_id);

// activity — append-only audit & event log with hash chain
activity {
  id: bigserial primary key
  actor_id: uuid references actors(id) not null
  on_behalf_of_actor_id: uuid references actors(id)   // for agent acting for user
  verb: text not null                       // 'created' | 'updated' | 'shared' | 'deleted' | 'tool.invoked' | 'llm.called' | ...
  object_type: text not null
  object_id: uuid
  tool_id: text                             // if invoked via tool registry
  trace_id: text                            // OTel trace id for correlation
  span_id: text
  metadata: jsonb default '{}'
  prev_hash: text                           // SHA256 of previous row (hash chain)
  this_hash: text                           // SHA256 of this row's canonical encoding
  created_at: timestamptz default now()
}
create index on activity (created_at desc);
create index on activity (actor_id, created_at desc);
create index on activity (trace_id);
create index on activity (object_type, object_id);

// outbox — for transactional event publishing
outbox {
  id: bigserial primary key
  subject: text not null
  payload: jsonb not null
  trace_id: text
  created_at: timestamptz default now()
  delivered_at: timestamptz
  attempts: int default 0
  last_error: text
}
create index on outbox (delivered_at) where delivered_at is null;

// ai_artifacts — provenance for AI-generated content
ai_artifacts {
  id: uuid primary key
  actor_id: uuid references actors(id) not null
  feature: text not null                    // 'mail.compose-help'
  provider_id: text not null
  model: text not null
  prompt_hash: text not null
  input_tokens: int
  output_tokens: int
  cost_usd_micros: bigint
  latency_ms: int
  classification: text
  tool_calls: jsonb                         // list of tools called and outcomes
  retrieved_context_ids: uuid[]             // ids of objects/threads retrieved for RAG
  trace_id: text
  created_at: timestamptz default now()
}

// memory_items — per-actor opt-in memory
memory_items {
  id: uuid primary key
  actor_id: uuid references actors(id) not null
  source: text not null                     // 'assistant.conversation' | 'mail.entity-extract' | ...
  content: text not null
  embedding: vector(768)                    // when pgvector backend
  created_at: timestamptz default now()
  expires_at: timestamptz
}

// pending_actions — confirmation queue
pending_actions {
  id: uuid primary key
  initiating_actor_id: uuid references actors(id) not null
  approver_actor_id: uuid references actors(id)
  tool_id: text not null
  input: jsonb not null
  status: text not null                     // 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
  decided_at: timestamptz
  expires_at: timestamptz not null
  trace_id: text
  result: jsonb
  created_at: timestamptz default now()
}

// platform_config — admin UI overrides
platform_config {
  key: text primary key
  value: jsonb not null
  set_by_actor_id: uuid references actors(id)
  set_at: timestamptz default now()
}

// installed_plugins — registry of plugins in this deployment
installed_plugins {
  id: text primary key                      // 'com.helix.core.mail'
  version: text not null
  source: text not null                     // 'bundled' | 'sideload' | 'registry'
  state: text not null                      // 'installed' | 'enabled' | 'disabled' | 'degraded'
  installed_at: timestamptz default now()
  enabled_at: timestamptz
  config_overrides: jsonb default '{}'
  permissions_granted_at: timestamptz
  manifest: jsonb not null
}

// app_passwords — per-actor passwords for IMAP/CalDAV/WebDAV
app_passwords {
  id: uuid primary key
  actor_id: uuid references actors(id) not null
  label: text not null
  password_hash: text not null              // argon2id
  scope: text not null                      // 'caldav' | 'webdav' | 'imap' | 'smtp'
  created_at: timestamptz
  last_used_at: timestamptz
  revoked_at: timestamptz
}
```

### 10.2 Plugin-owned tables (namespaced)

Each plugin namespaces its tables. Examples:

- `mail_filters`, `mail_aliases`, `mail_vacation`
- `chat_reactions`, `chat_room_settings`
- `drive_files`, `drive_folders` (with FK to `objects`)
- `docs_documents`, `docs_updates`
- `cal_calendars`, `cal_events`, `cal_attendees`
- `meet_rooms`
- `search_indexer_state`

Plugin migrations live in the plugin directory and run under a plugin-scoped Drizzle context. The platform tracks migration state per plugin in `installed_plugins.manifest.migrationsApplied`.

---

## 11. Frontend architecture & discipline

This section is binding for any code that runs in the browser. The agent loop should treat these as inviolable rules unless overridden by a decision record.

### 11.1 Visual identity: the shadcn preset is canonical

**Init command (run once at project bootstrap):**

```bash
cd apps/web
npx shadcn@latest init --preset b1D0dv72 --template vite
```

The preset defines the canonical visual identity of Helix: color palette, typography, spacing, radii, elevation, motion. **Do not override the preset's visual decisions with a parallel token system.** Earlier versions of this PRD layered Material 3 tokens on top; that approach is dropped. The preset wins.

What this means in practice:

- shadcn's generated `components.json` and `index.css` are the source of truth for design tokens
- New shadcn components added with `npx shadcn@latest add <component>` inherit the preset's identity automatically
- Tailwind utilities reference the preset's CSS variables (`--background`, `--foreground`, `--primary`, etc.)
- Custom components built in `apps/web/src/components/` use the same variables; no parallel token vocabulary
- Charts, dashboards, and plugin-contributed UI surfaces use the preset's variables — branding is consistent across every plugin

**What the admin can customize (Tier 2+ branding):**

- Logo (top-left of shell, login screen, email signatures)
- Primary accent color (overrides `--primary`; recomputes derived variables)
- Display name ("ACME Workspace" instead of "Helix")
- Login background image

That's it. Admins cannot change typography, radii, spacing scale, or elevation. The visual identity stays coherent across deployments.

### 11.2 Color modes: light, dark, system

Three modes, persisted per-user in `users.settings.colorMode`:

- `light` — explicit light mode
- `dark` — explicit dark mode
- `system` — follows `prefers-color-scheme` (default for new users)

**Implementation rules:**

- Mode is set on the `<html>` element as a class (`light` or `dark`) by a small bootstrap script that runs before React mounts (avoid flash of wrong theme on load)
- Every preset CSS variable has both a light and a dark value
- Switching modes is a class swap; transitions are limited to `color` and `background-color` over 150ms; no layout shift
- Charts, code blocks, syntax highlighting, image overlays, and any non-shadcn surface must read the mode and adapt
- The current mode is exposed to plugins via `useColorMode()` in the Web SDK

The toggle lives in the account menu (top-right). It also has a command-palette entry (`Cmd-K` → "Toggle theme").

### 11.3 Modals, never browser popups

**Hard discipline rule.** Helix never invokes a browser-native popup or confirmation. This is binding for all code, including plugins.

| Banned API | Replacement |
|---|---|
| `window.alert()` | shadcn `<Dialog>` with a single OK button (`AlertDialog` from shadcn is appropriate) |
| `window.confirm()` | shadcn `<AlertDialog>` with Confirm / Cancel buttons |
| `window.prompt()` | shadcn `<Dialog>` with an `<Input>` and form handling |
| `window.open()` for confirmations | In-app `<Dialog>` |
| `window.open()` for "are you sure?" | In-app `<AlertDialog>` |
| `beforeunload` native dialog for unsaved changes | TanStack Router `useBlocker()` + in-app `<AlertDialog>` |
| Permissions API native prompts (for things we can defer) | In-app explanation modal first, then native call |
| `OAuth popup window` for our own auth | Full-page redirect via TanStack Router |

**What's still allowed:**

- File picker (`<input type="file">`) — that's a system dialog, not a popup, and there's no in-app alternative
- Native notification API after user enables — those are system-level, not popups
- New tab via `<a target="_blank">` — opening a route in a new tab is fine; what's banned is `window.open` for a JavaScript-controlled popup window
- OAuth-out redirects to *third-party* providers (Google sign-in, etc.) — those are full-page redirects, not popups

**Enforcement:**

- ESLint rule (custom, in `packages/config/eslint`) bans `window.alert/confirm/prompt/open` and `beforeunload` literal in source; passes only when explicitly disabled with a `// eslint-disable-next-line helix/no-native-popup` and a justifying comment
- CI runs the lint; failing builds reject the PR
- The custom `<AlertDialog>` wrappers are exported from `@helix/sdk-web` so plugins use the same primitives

### 11.4 Navigation model: persistent left rail, single SPA, route-driven

**The Google-Workspace-like pattern:**

- A persistent **left rail** with icon entries for each enabled feature (Mail, Chat, Drive, Docs, Calendar, Meet, Assistant, Settings, Admin)
- Each entry is a route; clicking navigates the main content area
- The rail collapses to icon-only on narrow viewports (< 1024px)
- The shell — left rail + top bar + main content area + optional right rail — is consistent across every route
- **No multi-window UI.** Helix is a single SPA. Each "app" is a route, not a separate window or browser tab. (Users can manually open routes in new browser tabs; that's their choice, not ours.)

**Route structure** (TanStack Router file-based):

```
src/routes/
├── __root.tsx                  # shell layout
├── index.tsx                   # → redirects to /mail (or last-used route)
├── login.tsx                   # full-screen, no shell
├── signup.tsx                  # full-screen, no shell
├── _shell.tsx                  # layout route — shell wraps everything inside
│   ├── mail/                   # contributed by core-mail plugin
│   │   ├── index.tsx
│   │   ├── $threadId.tsx
│   │   └── compose.tsx
│   ├── chat/
│   ├── drive/
│   ├── docs/
│   ├── calendar/
│   ├── meet/
│   ├── assistant/
│   ├── settings/
│   └── admin/                  # admin-only routes
└── oauth/
    └── callback.tsx
```

Plugins register additional routes under `/_shell/<plugin-slug>/` via `registerShellRoute()`. The plugin loader merges plugin-contributed routes into the route tree at startup.

**Route-level data loading:**

Every route that needs server data uses a TanStack Router **loader** that calls into TanStack Query — not in-component `useQuery`. Loaders prefetch as soon as the route starts to mount, reducing perceived latency.

```typescript
// Example route loader pattern (binding for every data-driven route)
export const Route = createFileRoute('/_shell/mail/$threadId')({
  loader: async ({ params, context }) => {
    await context.queryClient.ensureQueryData(threadQueryOptions(params.threadId));
  },
  component: ThreadView,
});

function ThreadView() {
  const { threadId } = Route.useParams();
  const { data } = useSuspenseQuery(threadQueryOptions(threadId));
  // No loading state to handle — Suspense + the loader guarantee data is ready
  return <Thread thread={data} />;
}
```

### 11.5 TanStack discipline (binding patterns)

Helix's frontend speed comes from disciplined TanStack usage. These patterns are required:

**Router:**
- File-based routing exclusively (TanStack Router plugin in Vite config)
- Route loaders for every data-driven route (no in-component initial fetches)
- Typed search params via Zod schemas on every route that uses them
- `useBlocker()` for unsaved-changes guards; never `beforeunload`
- Type-safe `<Link>` components everywhere; no raw `<a href>` for internal navigation

**Query:**
- `queryOptions` factories per feature (`packages/web/src/features/<feature>/queries.ts` exports them)
- `useSuspenseQuery` is the default; `useQuery` only when error/loading need bespoke handling
- All mutations use `useMutation` with `onMutate` for optimistic updates and `onError` for rollback
- Query invalidation via `queryClient.invalidateQueries({ queryKey: ... })` after mutations; never manual refetch calls
- `staleTime: 30s` default; longer for stable resources
- Default ESLint rule: forbid calling `useQuery` directly without going through a `queryOptions` factory

**Form:**
- TanStack Form for every form, including 1-field "rename" dialogs
- Zod validators on every field
- Async validators for server-side checks (e.g., "is this email available")
- No `react-hook-form`, no `formik`, no `final-form`, no ad-hoc `useState` form state

**Table:**
- TanStack Table v8 for every data grid:
  - Admin user list, audit log, agent management, webhook list, plugin list, mail filters
  - Drive list view, search results list view
- Headless tables; the shadcn `<Table>` primitives wrap them
- Server-side sorting/filtering/pagination where the data is large

**Virtual:**
- TanStack Virtual for every list with more than 50 expected items:
  - Mail thread list (potentially tens of thousands of threads)
  - Chat message stream
  - Drive grid + list
  - Search results
  - Audit log
- Skeleton items render during loads to preserve scroll height

**Store:**
- TanStack Store for client-only state that doesn't belong in URL or server:
  - Sidebar collapsed/expanded
  - Selected message IDs in mail list (multi-select)
  - Composer draft (while in-flight; saved to server on debounce)
  - Density mode preference (until persisted to server)
- **URL state is preferred over Store state** when the state should be shareable, bookmarkable, or back-button-restorable (e.g., current label filter, search query, sort order). Store is for genuinely ephemeral UI state.

**Pacer:**
- `useDebouncedValue` for search-as-you-type inputs (300ms default)
- `useThrottledCallback` for typing indicators (sending), scroll handlers
- No homegrown `setTimeout` for debouncing

### 11.6 The shell

Platform-owned. Plugins contribute *into* it; they do not replace it.

**Left rail (collapsible):**

- Items contributed by plugins via `registerLeftRailItem()`
- Default order: Mail (1), Chat (2), Drive (3), Docs (4), Calendar (5), Meet (6), Assistant (7), then plugin-contributed extras (alphabetical), then Settings, then Admin (only visible to admins)
- Each item: icon (lucide-react), label, optional badge (unread count via async function), keyboard shortcut
- Collapses to icon-only below 1024px viewport width
- Active route gets a visible highlight per the preset's active-state pattern

**Top bar:**

- Logo (left)
- Global search input (centered, full width on mobile): opens `cmdk` palette on focus; searches across all enabled plugins' indexers; results grouped by entity type
- Notification bell (right, with badge for unread count): opens a dropdown with recent notifications
- Account chip (rightmost): opens a menu with profile, color mode toggle, density toggle, settings, logout
- Help button (optional): opens contextual help based on current route

**Main content:**

Plugin-contributed route renders here. The route's component gets full control of layout within the content area; the shell does not impose padding or container constraints — that's the route's choice.

**Right rail (optional):**

- Plugins contribute panels via `registerRightRailPanel()` declaring `appliesTo(route, ctx)`
- The user toggles the right rail open/closed; state is per-route
- The Helix Assistant's right-rail panel (`com.helix.core.assistant`) is the most-used: it's a chat surface available across every route, with context-awareness of where you are in the app

**Density modes:**

- Comfortable (default) and Compact
- Persisted per user
- Affects row heights, padding, font sizes — all driven by CSS variables that the preset's components respect

### 11.7 Loading, error, and empty states

Three places every plugin must handle:

**Loading:** Suspense boundaries with skeleton states that match the shape of the eventual content. Never spinners. Never blank screens. Skeletons should preserve layout — switching from skeleton to content should not cause layout shift.

**Error:** TanStack Router error components per route. Show the actual error (sanitized) and an action — "Retry" most commonly. For unexpected errors, log to Sentry (if Tier 2+ configured) and show a generic "Something went wrong" with a `trace_id` the user can quote in support requests.

**Empty:** Every list view has an empty state component with a single sentence of guidance and a primary CTA. "No mail yet — your inbox will appear here." "No files — drag and drop or click Upload."

### 11.8 Motion and microinteraction

- `framer-motion` for the few animations that matter: route transitions (subtle fade, 150ms), sheet/drawer open-close, toast in/out
- No bouncy animations, no parallax, no scroll-jacking
- Snackbar/toast via `sonner`, top-right, 4s auto-dismiss; consequential actions get an Undo button
- Loading spinners only when there is literally no way to predict content shape (a rare case); prefer skeletons

### 11.9 Performance discipline

- Code-split per plugin route via TanStack Router's automatic route-level splitting
- Lazy-load plugin UI bundles; the initial bundle should not exceed 250KB gzipped for the shell + core dependencies
- Image optimization: thumbnails generated server-side (sharp), served via signed URLs
- Lighthouse score targets: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95 on the main routes
- Web Vitals tracked via the OTel browser SDK and shown in the Grafana stack's frontend dashboard

### 11.10 Accessibility

- WCAG 2.2 AA target
- axe-core runs in CI on every route via Playwright
- All interactions keyboard-navigable; visible focus rings
- Screen reader tested: NVDA on Windows, VoiceOver on macOS, TalkBack on Android (manual quarterly review)
- Color contrast meets AA for both light and dark modes (the preset is responsible; verify after install)
- Reduced motion respected (`prefers-reduced-motion`)
- All icons have accessible names; decorative icons have `aria-hidden`

### 11.11 Internationalization (foundation)

Strings extracted via `i18next` (or compatible) with a translation key system. v1 ships English only; the structure supports adding locales without code changes. Plugins can contribute their own strings under a plugin-scoped namespace.

Dates, numbers, and currencies via `Intl` APIs. Time zones respect user setting.

---



## 12. Feature plugins

Each first-party feature plugin gets a short spec here. Full implementation specs live in the plugin's README.md. **Every feature plugin uses only the platform SDK** — no internal shortcuts.

### 12.1 `com.helix.core.mail`

**Tables:** `mail_filters`, `mail_aliases`, `mail_vacation` (namespaced); uses platform `threads`, `messages`, `objects`.

**Tools registered:**
- `mail.send` — see Section 8.5 example
- `mail.reply` — reply to a thread
- `mail.label.apply` — apply/remove labels
- `mail.archive`, `mail.delete`, `mail.snooze`
- `mail.filter.create`, `mail.filter.update`, `mail.filter.delete`
- `mail.search` — typed mail search

**Capabilities provided:** `smtp-listener`, `tools:mail.*`, `indexer:mail`, `ui-route:/mail`, `notification-source:mail.received`.

**Capabilities consumed:** `storage`, `search`, `permissions`, `notifier`, `ai-routing` (optional), `vector-store` (optional).

**In-process SMTP** via `smtp-server` library; ingest pipeline reads spam/virus check results (Tier 2+ ClamAV plugin if configured), evaluates filters, inserts message + attachments in one Postgres transaction with outbox entry.

**Outbound mail** via `nodemailer` to configured relay (SES/Mailgun/Postmark). 30s undo-send window via delayed outbox dispatch.

**AI integration points:**
- `mail.compose-help` — slot in composer
- `mail.subject-from-body` — slot
- `mail.summarize-thread` — slot in reader
- `mail.suggest-reply` — slot in reader
- Enrichment: `mail.entity-extract`, `mail.classification`

**Acceptance criteria:** see Section 7.1 of v1.2 (carry forward), plus:
- All operations also available as tools via MCP
- CLI `helix mail send/reply/list/search` works
- Filter creation via tool produces same result as via UI

### 12.2 `com.helix.core.chat`

Reuses `threads` (channel `chat_room`/`chat_dm`/`call`) and `messages`. Adds `chat_reactions`, `chat_room_settings`, `chat_pins`.

**Tools:** `chat.send`, `chat.react`, `chat.edit`, `chat.delete`, `chat.create_room`, `chat.invite`, `chat.search`.

**Real-time** via Fastify WebSocket at `/ws/chat`; NATS subjects per room. Presence in Redis with TTL.

**AI integration:** `chat.suggest-reply`, `chat.summarize-room`; enrichment `chat.action-items`.

### 12.3 `com.helix.core.drive`

Adds `drive_folders`, `drive_versions`; uses `objects` for blobs.

**Tools:** `drive.upload` (returns presigned URL), `drive.finalize`, `drive.list`, `drive.share`, `drive.move`, `drive.trash`, `drive.restore`, `drive.delete`, `drive.search`.

**Preview** via plugin-contributed `PreviewRenderer` capability. First-party renderers: image, PDF, video, audio, text. Office file preview via `drive-preview-libreoffice` plugin (separate container).

**AI integration:** `drive.summarize-file`, `drive.describe-image`; enrichment `drive.auto-tag`.

### 12.4 `com.helix.core.docs`

Adds `docs_documents`, `docs_updates` (the in-API Yjs sync log) and `docs_comments`.

**Tools:** `docs.create`, `docs.update-title`, `docs.export` (PDF, DOCX, Markdown), `docs.comment.create`.

**Editor** is Tiptap + Yjs in the web app. **Sync** is a Fastify WebSocket route at `/sync/docs/:docId` implementing the Yjs sync protocol (`y-protocols`), persisting incremental updates to `docs_updates`, debouncing into compacted `docs_documents.ydoc_state` snapshots.

**AI integration:** `docs.smart-write`, `docs.summarize`, `docs.translate`; enrichment `docs.outline`.

### 12.5 `com.helix.core.calendar`

Adds `cal_calendars`, `cal_events`, `cal_attendees`.

**Tools:** `calendar.event.create/update/delete`, `calendar.event.respond`, `calendar.find-time`.

**CalDAV** sub-app at `/dav/cal/*` with Basic auth via `app_passwords`.

**.ics invitations** sent via mail plugin.

**AI integration:** `calendar.suggest-meeting-time`, `calendar.draft-agenda`.

### 12.6 `com.helix.core.meet-jitsi` (v1)

Adds `meet_rooms` referencing `threads` (channel `call`).

**Tools:** `meet.create-room`, `meet.mint-token`, `meet.end-room`.

JWT minted by the platform from the actor's session; signed with the shared secret with Prosody.

Recording uploads land in `objects` (kind `recording`) and become attachments on the call thread.

**v2 replacement:** `com.helix.core.meet-mediasoup` — same interface, in-process Mediasoup signaling. The plugin contract is designed to be replaceable.

### 12.7 `com.helix.core.search-meilisearch`

Implements the `SearchEngine` capability backed by Meilisearch. Subscribes to `activity.*` via NATS. Other plugins register their indexers, which project events to `IndexDoc` shape.

When a `VectorStore` and `EmbeddingProvider` are configured, performs hybrid search with RRF.

**Alternative implementations** (third-party-friendly): `com.helix.search-typesense`, `com.helix.search-elasticsearch`.

### 12.8 `com.helix.core.storage-rustfs`

Implements `StorageProvider` backed by RustFS. Used by the platform's `storage` capability.

**Alternatives:** `com.helix.storage-s3` (AWS S3), `com.helix.storage-r2` (Cloudflare R2), `com.helix.storage-b2` (Backblaze B2), `com.helix.storage-azure-blob`, `com.helix.storage-gcs`.

### 12.9 `com.helix.core.assistant` (Helix AI)

The conversational AI interface. Provides:

- **UI:** Right-rail panel + `/assistant` full page; Tiptap-based message stream; tool-call cards with confirm/cancel; citation chips; provenance details on click
- **Backend:** orchestrates LLM + tool registry + search + memory
- **Slash commands:** `/draft mail to X about Y`, `/summarize this thread`, `/find files about Z`, `/schedule meeting with A and B next week`
- **Memory:** opt-in per-user via `MemoryStore` capability; admin can disable per-tier policy

The assistant has no privileged access. It calls platform tools as the actor. All confirmation gates apply.

### 12.10 AI provider plugins (first-party)

- `com.helix.ai-provider-openai-compat` — covers OpenAI, Azure OpenAI, Ollama, vLLM, etc.
- `com.helix.ai-provider-anthropic-compat` — direct Anthropic API
- `com.helix.ai-provider-bedrock` — Anthropic on AWS Bedrock
- `com.helix.ai-provider-vertex` — Anthropic on GCP Vertex
- `com.helix.embedding-openai-compat` — OpenAI/Ollama/etc embeddings

### 12.11 Vector store plugins (first-party)

- `com.helix.vector-pgvector` — default; uses existing Postgres
- `com.helix.vector-qdrant` — separate Qdrant service
- `com.helix.vector-milvus` — separate Milvus cluster
- `com.helix.vector-chroma` — Chroma server
- `com.helix.vector-weaviate` — Weaviate

### 12.12 Other first-party plugins

- `com.helix.core-mcp-server` — MCP protocol surface for the tool registry
- `com.helix.core-openapi` — auto-generates OpenAPI 3.1 from routes and tools
- `com.helix.core-asyncapi` — aggregates plugin-contributed event schemas
- `com.helix.core-cli` — the `helix` CLI
- `com.helix.observability-otel` — OTel SDK setup, exporter
- `com.helix.observability-grafana-stack` — provisions Grafana + Tempo + Loki + Prometheus
- `com.helix.audit-immutable-s3` — ships audit log to S3 with Object Lock
- `com.helix.audit-siem-syslog` — ships audit to a SIEM via syslog/CEF
- `com.helix.secrets-sops` — secrets via SOPS-encrypted files
- `com.helix.secrets-vault` — secrets via HashiCorp Vault
- `com.helix.drive-preview-libreoffice` — Office file → PDF preview via headless LibreOffice
- `com.helix.drive-av-scan-clamav` — ClamAV scanning of uploads (Tier 2+)

### 12.13 Webhooks (in and out)

Webhooks are first-class platform capabilities — both outbound (Helix → external) and inbound (external → Helix). They are part of Phase 0 because they're how Helix connects to the rest of an org's tool ecosystem from the moment it ships.

#### 12.13.1 The webhook engine: `com.helix.webhook-engine`

A platform plugin (loaded in Phase 0) that provides:

- The `WebhookOutboundCapability` and `WebhookInboundCapability` interfaces in the SDK
- Storage tables (`webhooks_outbound`, `webhooks_inbound`, `webhook_deliveries`)
- The outbound delivery worker (subscribes to NATS subjects, dispatches HTTP POSTs with retries)
- The inbound handler at `/webhooks/<id>` (HMAC verification, routing to platform actions)
- Tools: `webhook.outbound.create/list/update/delete/test`, `webhook.inbound.create/list/update/delete/rotate-secret`
- Admin UI: webhook management section under Settings → Webhooks
- Delivery log table with retry stats, last delivery status, response codes

#### 12.13.2 Data model (webhook engine tables)

```sql
webhooks_outbound (
  id              uuid primary key,
  name            text not null,
  enabled         boolean default true,
  url             text not null,
  secret          text not null,                       -- for HMAC signing
  events          text[] not null,                     -- NATS subjects to subscribe to
  filters         jsonb default '{}',                  -- optional matcher (e.g., specific labels)
  headers         jsonb default '{}',                  -- additional headers
  format          text not null default 'helix-json',  -- 'helix-json' | 'slack' | 'discord' | 'teams' | 'custom-template'
  template        text,                                -- for custom-template format
  timeout_ms      int default 5000,
  max_retries     int default 5,
  created_by      uuid references actors(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
)

webhooks_inbound (
  id              uuid primary key,
  name            text not null,
  slug            text unique not null,                -- becomes /webhooks/<slug>
  enabled         boolean default true,
  secret          text not null,                       -- for HMAC verification
  source_type     text not null,                       -- 'generic' | 'github' | 'gitlab' | 'stripe' | 'linear' | ...
  signature_header text default 'x-helix-signature',
  signature_algo  text default 'hmac-sha256',
  signature_format text default 'hex',                 -- 'hex' | 'base64' | 'sha256=<hex>' (GitHub style)
  routing         jsonb not null,                      -- maps incoming payload → platform actions
  rate_limit      jsonb,                               -- per source-IP rate limits
  ip_allowlist    cidr[],
  created_by      uuid references actors(id),
  created_at      timestamptz default now()
)

webhook_deliveries (
  id              uuid primary key,
  direction       text not null,                       -- 'outbound' | 'inbound'
  webhook_id      uuid not null,                       -- FK to webhooks_outbound or webhooks_inbound
  event_subject   text,                                -- for outbound: NATS subject; for inbound: 'inbound'
  payload         jsonb,                               -- redacted body for audit
  status          text not null,                       -- 'pending' | 'delivered' | 'failed' | 'retrying' | 'received' | 'rejected'
  status_code     int,                                 -- HTTP response code
  response_excerpt text,                               -- first 1KB of response or error
  attempts        int default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  trace_id        text,
  created_at      timestamptz default now()
)
create index on webhook_deliveries (webhook_id, created_at desc);
create index on webhook_deliveries (status) where status in ('pending', 'retrying');
```

#### 12.13.3 Outbound webhooks — delivery pipeline

1. The engine subscribes to NATS subjects declared by enabled outbound webhooks
2. On event receipt, evaluates each matching webhook's filter
3. If matched, renders the payload via the configured format/template
4. Inserts a `webhook_deliveries` row with status `pending`
5. The delivery worker picks it up, constructs the HTTP request:
   - `Content-Type: application/json`
   - `User-Agent: Helix-Webhooks/1.0`
   - `X-Helix-Event: <subject>`
   - `X-Helix-Delivery: <delivery-id>`
   - `X-Helix-Signature: hmac-sha256=<hex>` (signed with the webhook's secret)
   - `Authorization` and other headers from the `headers` config
6. POSTs with the configured timeout
7. On 2xx: marks delivered, records status code, response excerpt
8. On 4xx (except 408/429): marks failed, no retry
9. On 5xx, 408, 429, or network error: schedules retry with exponential backoff (1m, 5m, 30m, 2h, 12h); marks failed after `max_retries`
10. Emits its own `webhook.delivered` activity for observability

**Signing format:**

```
X-Helix-Signature: hmac-sha256=<hex_digest>

where hex_digest = HMAC_SHA256(secret, <delivery_id> + "." + <timestamp> + "." + <body>)
```

Receivers verify by recomputing; the platform's docs page (`/docs/webhooks/verify`) includes verification snippets in JS, Python, Go, Ruby, PHP.

**Replay protection:** delivery includes `X-Helix-Timestamp`. Receivers should reject deliveries with timestamps older than 5 minutes.

#### 12.13.4 Outbound webhook format plugins

Each format plugin transforms a Helix event into a destination-specific shape:

- **`com.helix.webhook-out-generic`** — Helix's native JSON envelope:
  ```json
  {
    "id": "<delivery-id>",
    "event": "mail.received",
    "createdAt": "2026-05-19T...",
    "object": { /* event payload */ },
    "actor": { "id": "...", "displayName": "...", "type": "user" }
  }
  ```
- **`com.helix.webhook-out-slack`** — Slack incoming webhook format. The template UI in admin lets the user customize message text, attachments, blocks. Sensible defaults per event type (mail received → blocks with sender, subject, preview).
- **`com.helix.webhook-out-discord`** — Discord webhook format (embeds, content).
- **`com.helix.webhook-out-teams`** — Microsoft Teams Adaptive Card format.
- **`com.helix.webhook-out-pagerduty`** — PagerDuty Events API v2 (Tier 2+ for ops integrations).
- **`com.helix.webhook-out-custom-template`** — Liquid/Handlebars template authored by admin; renders against the event JSON. Useful when a destination isn't yet first-party.

Adding a new format is a small plugin: declare the format id, implement a `render(event, config) → HTTPRequest` function.

#### 12.13.5 Inbound webhooks — receiving pipeline

1. A webhook is created in admin UI with a unique slug (e.g., `github-prod`)
2. Helix exposes `POST /webhooks/<slug>`
3. On receipt, the engine looks up the inbound webhook, verifies HMAC against the configured signature header/algorithm/format
4. If a `source_type` is set (e.g., `github`), source-specific handling kicks in (e.g., GitHub uses `X-Hub-Signature-256` header)
5. Payload routed via the `routing` config — maps fields in incoming JSON to platform actions:
   ```yaml
   routing:
     - condition: { 'X-GitHub-Event': 'push' }
       action:
         tool: chat.send
         input:
           roomId: '${routing.targetRoomId}'
           body: 'Push to ${ref} by ${pusher.name}: ${commits.length} commits'
     - condition: { 'X-GitHub-Event': 'pull_request', 'payload.action': 'opened' }
       action:
         tool: chat.send
         input: ...
   ```
6. Action runs via the tool registry; the inbound webhook's `created_by` actor is the principal — so the action is scoped to whatever that actor can do
7. Records a `webhook_deliveries` row with status `received` or `rejected`

**Why scoping to `created_by`:** the inbound webhook is essentially a tool invocation as the actor who set it up. Their permissions apply. An admin can create a webhook that posts to any room; a regular user can only post to rooms they're a member of.

#### 12.13.6 Inbound webhook source plugins

- **`com.helix.webhook-in-generic`** — generic HMAC-SHA256 verification with configurable header/format. The fallback.
- **`com.helix.webhook-in-github`** — handles GitHub's `X-Hub-Signature-256` header format, parses `X-GitHub-Event` for routing, knows GitHub's payload shapes for `push`, `pull_request`, `issues`, `release`, etc.
- **`com.helix.webhook-in-gitlab`** — GitLab's `X-Gitlab-Token` simple secret comparison + event header
- **`com.helix.webhook-in-stripe`** — Stripe's `Stripe-Signature` format with timestamp + signature pair
- **`com.helix.webhook-in-linear`** — Linear's signature format and event types
- **`com.helix.webhook-in-grafana`** — Grafana alert webhook format (alert firing → action)
- **`com.helix.webhook-in-prometheus`** — Alertmanager webhook format

Each source plugin: declares its `source_type`, exposes signature-verification logic, exposes payload-parsing helpers, and provides admin-UI hints about which fields the routing engine can match against.

#### 12.13.7 Admin UI for webhooks

Under Settings → Webhooks:

- **Outbound tab:** TanStack Table listing all outbound webhooks with status (enabled, last-delivery, recent-failure-rate). Click row to edit. New button opens a wizard: name → URL → event subjects (multi-select with autocomplete from registered NATS subjects) → format (Slack/Discord/Teams/generic/custom) → format-specific template editor → test fire → save.
- **Inbound tab:** Listing with slug, source type, recent activity. New button opens wizard: name → source type → routing rules editor → IP allowlist → "Copy URL + secret" panel for the receiving end.
- **Deliveries tab:** TanStack Table + TanStack Virtual showing the `webhook_deliveries` log; filterable by direction, status, webhook, time range. Click for full payload + response detail.

Every webhook table row has actions: Enable/Disable, Test Fire (outbound) / Test Verify (inbound), Rotate Secret, Delete.

#### 12.13.8 Tools (registered by webhook engine)

```
webhook.outbound.create
webhook.outbound.update
webhook.outbound.delete
webhook.outbound.test                  # fires a synthetic event
webhook.outbound.list
webhook.outbound.replay                # re-deliver a failed delivery

webhook.inbound.create
webhook.inbound.update
webhook.inbound.delete
webhook.inbound.rotate-secret
webhook.inbound.list

webhook.delivery.get                   # by id
webhook.delivery.list
```

All available via tRPC, REST (via OpenAPI), MCP, and CLI. Webhooks can be administered by agents (with `admin.webhooks` scope) — useful for IaC-style management.

#### 12.13.9 Security considerations per tier

| Concern | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| Outbound URL allowlist | Off | Optional | Required | Required (curated) |
| Outbound payload classification check | Off | On (block `restricted` outbound) | On (block `confidential` + `restricted`) | On (default deny external; explicit per-webhook approval) |
| Inbound IP allowlist | Optional | Recommended | Required | Required |
| Signature algorithms | sha256 | sha256 | sha256, sha512 | sha512, with mandatory replay window |
| Audit of every delivery | On | On + shipped | On + immutable + SIEM | On + WORM + SIEM |
| Per-webhook rate limit | Default | Default | Required configured | Required + strict |
| Secret storage | env-encrypted | SOPS/Vault | Vault (rotation 30d) | Vault + HSM-backed |

#### 12.13.10 Observability

Every outbound delivery produces an OTel span (`webhook.outbound.<id>`); every inbound receive produces a span (`webhook.inbound.<id>`). Delivery latency, success/failure, retry counts, payload size all captured. The Grafana stack ships a Webhooks dashboard out of the box.

#### 12.13.11 References

- Webhook security best practices: https://webhooks.fyi/
- Stripe webhook signing: https://docs.stripe.com/webhooks#verify-official-libraries
- GitHub webhook signatures: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Slack incoming webhooks: https://api.slack.com/messaging/webhooks
- Discord webhooks: https://discord.com/developers/docs/resources/webhook
- Microsoft Teams incoming webhooks: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook

---

## 13. APIs (three surfaces, one source)

The tool registry projects onto three protocol surfaces simultaneously, all generated from the same registry data:

### 13.1 tRPC (web SPA)

Mounted at `/trpc/*`. End-to-end typed via TypeScript inference. The web app uses TanStack Query integration. Procedures are auto-generated from registered tools (the platform creates a tRPC procedure for each tool, with the input/output schemas).

### 13.2 REST + OpenAPI 3.1 (HTTP clients, agents)

Every tool becomes an HTTP endpoint at `POST /api/tools/<tool-id>`. Idempotent reads also get `GET` aliases. The full surface is described at `/openapi.json`. Swagger UI at `/docs`.

Authentication options:
- Session cookie (web)
- OAuth 2.1 bearer token (agents, CLI, third-party integrations)
- App password (Basic auth — for legacy clients like CalDAV)

### 13.3 MCP (agent frameworks)

The MCP server (`/mcp`) exposes:
- `tools/list` — every tool the authenticated actor can call (Cerbos-filtered)
- `tools/call` — invokes a tool
- `resources/list` and `resources/read` — entity references the actor can read (recent mail, files, threads)
- `prompts/list` — saved prompts (v1.5)

Compatible MCP clients consume this immediately — Claude Desktop, Goose, OpenHands, Cursor, etc. require no per-product integration code.

### 13.4 AsyncAPI (events)

`/asyncapi.json` describes available event subjects with payload schemas. Two delivery mechanisms:
- WebSocket subscription at `/events/ws` with subject filter + bearer auth
- Webhook delivery to admin-configured URLs (with HMAC signing)

### 13.5 Internal HTTP endpoints

- `POST /webhook/ses` — SES SNS webhooks (signature-verified)
- `POST /webhook/jitsi` — Jitsi events (shared-secret)
- `POST /internal/policy/reload` — manual Cerbos policy reload trigger

### 13.6 Compatibility endpoints

- `/dav/cal/*` — CalDAV (RFC 4791)
- `/dav/card/*` — CardDAV (v1.5)
- `/dav/files/*` — WebDAV
- `/ical/<token>` — public iCal feed
- `/oauth/token`, `/oauth/authorize` — OAuth 2.1 endpoints

---

## 14. Security tiers

The security model is **tier-based with per-layer overrides**. Each tier sets defaults; admins can override any control.

### 14.1 Tier 1: Personal

Target: single-VPS basement install, personal email, small team (<10).

| Layer | Default |
|---|---|
| Transit (edge) | TLS 1.3 via Caddy |
| Transit (internal) | Plaintext on Docker network |
| At-rest (Postgres) | Filesystem level only (whatever the host has) |
| At-rest (objects) | Plaintext in RustFS |
| Backup encryption | None (or basic gpg if admin chooses) |
| Secrets | Environment variables |
| Auth | Email/password + optional TOTP MFA |
| Audit log | Postgres only |
| Observability | Local OTel optional |
| AI providers | Any configured; user responsibility |
| Tools requiring confirmation | Destructive only |
| Agent IP allowlists | Optional |
| Network egress | Open |

Required services: 7 (Tier 1 base).

### 14.2 Tier 2: Business

Target: small-to-mid company, professional deployment, single region.

Changes from Tier 1:

| Layer | Default |
|---|---|
| Transit (internal) | **mTLS via Caddy upstream TLS** between Helix app and Postgres/NATS/Meili/Cerbos/RustFS |
| At-rest (Postgres) | **LUKS on data volume** (host-level) + Postgres TLS |
| At-rest (objects) | **SSE-S3** server-side encryption in RustFS/S3 |
| Backup encryption | **age** encryption before upload |
| Secrets | **SOPS** with age keys (default) or **Vault** |
| Auth | MFA required for admins; passkeys enabled |
| Audit log | **Shipped to immutable S3 (Object Lock)** in addition to Postgres |
| Hash chain | Enabled on audit table |
| Observability | OTel + bundled Grafana stack (recommended) |
| AI providers | Admin allowlist; classification gating |
| AI cost limits | $10/user/day, $500/org/day default |
| Tools requiring confirmation | Destructive + external_communication |
| Agent IP allowlists | Recommended |
| Network egress | Recommended allowlist |
| Branding | Custom logo + primary color enabled |
| PII redaction before AI send | On |

Required services: Tier 1 + SOPS/Vault + audit shipper + (optional) Grafana stack.

### 14.3 Tier 3: Enterprise

Target: regulated industries, HA required, may need data residency.

Changes from Tier 2:

| Layer | Default |
|---|---|
| Transit (internal) | **mTLS via SPIRE/SPIFFE** with workload identity certs (auto-rotated) |
| At-rest (Postgres) | **Postgres TDE** (or column-level pgcrypto for sensitive columns) |
| At-rest (objects) | **SSE-KMS** with customer-managed keys |
| Backup encryption | **KMS-backed** envelope encryption |
| Secrets | **HashiCorp Vault mandatory**, 90-day rotation |
| Auth | MFA required org-wide; passkeys preferred; SAML/OIDC SSO via plugin, additive to local owner/admin recovery login |
| Audit log | Shipped to **immutable S3 + SIEM** (syslog/CEF); hash chain verified daily |
| Observability | OTel + Grafana stack + correlation IDs in audit |
| AI providers | **Local providers preferred**; cloud requires BAA/DPA; per-feature opt-in |
| AI cost limits | $50/user/day default; per-org enforced |
| Confidential/restricted classifications | Block external AI providers |
| Tools requiring confirmation | All write tools by default |
| Agent IP allowlists | Required |
| Network egress | Allowlist required |
| HA | Postgres operator (CloudNativePG); 3-replica NATS; LB across Helix replicas |
| Backup | Daily + PITR; tested restore weekly |
| Plugin install | Signature verification required |

Required services: Tier 2 + Vault + SPIRE server/agents + HA Postgres operator + SIEM bridge.

### 14.4 Tier 4: Sovereign / DoD

Target: classified workloads, air-gapped, FIPS-validated, ATO-track.

Changes from Tier 3:

| Layer | Default |
|---|---|
| Crypto | **FIPS 140-3 validated modules** throughout (Node BoringCrypto, RustCrypto FIPS) |
| Base images | **STIG-compliant** (Iron Bank, Chainguard FIPS images) |
| Telemetry | Zero outbound telemetry; all stays in-perimeter |
| Auth | CAC/PIV smartcard via PKCS#11 plugin |
| Audit log | Shipped to **WORM** storage + SIEM in CEF/LEEF |
| AI providers | **Local only** (Ollama, vLLM, llama.cpp); no cloud providers permitted by policy |
| Plugin install | Signature verification required; manifests reviewed for outbound network |
| Plugin sources | Bundled or air-gap-installed only; no registry fetch |
| Network egress | Default deny; explicit allowlist with justification |
| Dual control | Required for destructive admin operations |
| Backup | Encrypted to HSM; cross-region replication; restore drill monthly |
| Compliance | NIST 800-53 control mapping doc; STIG checklist; ATO artifacts |

Required: full Tier 3 + FIPS adapters + STIG images + air-gap install tooling.

### 14.5 Per-layer override matrix

Every individual control in the table above can be overridden in `security.overrides`. The admin UI shows current tier defaults, currently overridden values, and provides "reset to tier default" buttons.

Tier upgrades are guarded by readiness checks (e.g., Personal → Business requires a successful encrypted backup); tier downgrades require admin confirmation and may relax security.

### 14.6 Threat model summary

| Threat | Tier 1 mitigation | Tier 2+ adds | Tier 3+ adds | Tier 4 adds |
|---|---|---|---|---|
| Credential stuffing | Rate limit + TOTP | Passkey, MFA req admins | MFA all + additive SSO for member access; local owner/admin recovery retained | CAC/PIV |
| Inbound mail spoof | SPF/DKIM/DMARC | + classification | + content scanning | + AV in restricted mode |
| Outbound abuse | Per-user quotas | + content scoring | + admin review of new senders | + dual control |
| Stored XSS in mail | DOMPurify + iframe sandbox | + CSP strict | + nonces per render | (same) |
| File upload exploit | MIME sniff | + ClamAV plugin | + sandbox preview | + air-gapped scan |
| SSRF via "fetch URL" | Block RFC1918 | + egress allowlist | + per-plugin allowlists | + default deny |
| Secrets in logs | Pino redact paths | + audit-checked | (same) | (same) |
| Cross-actor data leak | Cerbos on every op | + classification gating | + DLP scanning | + cryptographic separation |
| Insider DB tamper | (none meaningful) | Hash chain on audit | + immutable ship + SIEM | + WORM + dual-control admin |
| Provider exfil via AI | Classification + rate | + PII redact + cost cap | + local-only for restricted | + no cloud period |
| Agent compromise | Confirmation on destruct | + IP allowlist + cost cap | + short token lifetime | + dual-control destructive |
| Supply chain | `pnpm audit` | + signed plugin verify | + SBOM | + air-gapped registry |

---

## 15. Observability architecture

### 15.1 OpenTelemetry instrumentation

Every Helix process initializes the OpenTelemetry SDK on startup. Auto-instrumentation covers Fastify, Postgres (pg), Redis (ioredis), HTTP fetch (undici), and gRPC (Cerbos client). Custom instrumentation covers:

- **LLM calls:** span name `llm.chat`, attributes include `llm.provider`, `llm.model`, `llm.input_tokens`, `llm.output_tokens`, `llm.cost_usd_micros`, `llm.latency_ms`, `llm.feature` (e.g., `mail.compose-help`), `llm.classification`, `llm.routing_primary`, `llm.routing_fallback_used`, `llm.tool_calls_count`
- **Tool calls:** span name `tool.<id>`, attributes include `tool.id`, `tool.actor_id`, `tool.actor_type`, `tool.side_effects`, `tool.requires_confirmation`, `tool.confirmation_status`, `tool.result_status`
- **Permission checks:** span name `permission.check`, attributes `principal.id`, `principal.type`, `action`, `resource.type`, `resource.id`, `decision` (ALLOW/DENY), `policy.fired`
- **MCP requests:** span name `mcp.<method>`, attributes include client info, tool/resource id
- **SMTP receive/send:** span name `smtp.receive` or `smtp.send`; attributes include `mail.from`, `mail.to`, `mail.size`, `mail.spam_score`, `mail.dkim_pass`, `mail.spf_pass`
- **Yjs sync:** span name `yjs.sync`; attributes include doc id, update size, broadcasted client count
- **External HTTP calls** (from plugins): the platform-provided HTTP client wraps `undici` and emits spans
- **Background jobs:** span name `job.<id>`; attributes include schedule, leader status, duration

### 15.2 Trace propagation

W3C Trace Context (`traceparent`, `tracestate` headers) is propagated through:

- HTTP requests in and out
- NATS message headers (as carriers)
- WebSocket connections (carried in initial upgrade)
- LLM provider calls (carrier headers when supported)
- Scheduled job execution (synthesized trace per run)

### 15.3 Pre-built dashboards

The `observability-grafana-stack` plugin provisions Grafana dashboards as code (JSON in `/plugins/com.helix.observability-grafana-stack/dashboards/`):

1. **Platform overview** — request rate, error rate, latency, DB pool, NATS lag, search queue depth
2. **Mail dashboard** — SMTP receive/send rates, queue depth, bounce/complaint rates, DKIM/SPF/DMARC pass rates
3. **Chat dashboard** — active WS connections, message rate, presence updates, NATS subject lag
4. **Drive dashboard** — upload throughput, preview generation latency, storage usage
5. **Docs dashboard** — active Yjs sessions, sync update throughput, compaction lag
6. **AI dashboard** — LLM call rate by provider/model/feature, cost by provider/model/feature, latency percentiles, error rate, routing fallback rate, top-cost provider/model/feature routes
7. **Agent dashboard** — active agents, tool call rate by tool, confirmation gate metrics, denials by reason
8. **Security dashboard** — permission denials by resource type, authentication failures, MFA challenges, IP allowlist violations
9. **Audit dashboard** — activity rate, hash-chain verification status, shipping lag to immutable destination
10. **Per-plugin dashboards** — auto-generated from plugin metric names

### 15.4 Logging

Pino, JSON to stdout, captured by container runtime → Loki (via Promtail/Alloy) when the stack is enabled.

Log redaction: `password`, `secret`, `token`, `authorization`, request bodies for sensitive endpoints. Tier 3+ enforces stricter redaction.

### 15.5 Audit log

The `activity` table is the primary store. Each row includes a hash-chain link to the previous row (`prev_hash` + `this_hash`), where `this_hash = sha256(canonical_encoding_of_row)`. Daily verification job (`com.helix.audit-verifier`) walks the chain and alerts on tampering.

Audit destinations (Tier 2+):

- **`com.helix.audit-immutable-s3`** — buffers and ships to S3 with Object Lock (compliance retention mode); rotates files; verifies integrity
- **`com.helix.audit-siem-syslog`** — emits CEF/LEEF over syslog UDP/TCP/TLS to a SIEM (Splunk, QRadar, Elastic SIEM, etc.)
- **`com.helix.audit-immutable-postgres`** — ships to a separate Postgres with WORM-style triggers (no UPDATE, no DELETE)

Multiple destinations can be active simultaneously; tier engine enforces minimum destinations per tier.

### 15.6 Metrics

Prometheus client exposed at `/metrics`. Standard counters/histograms for HTTP, DB, NATS, LLM, tool calls. Plugins register their own metrics via `host.metric.counter(name, labels)`.

### 15.7 OTel exporter backends

The `observability-otel` plugin's `otlpEndpoint` config can point at:
- Bundled Tempo/Loki/Prometheus (via `observability-grafana-stack`)
- SigNoz
- Honeycomb
- Datadog
- New Relic
- Splunk Observability Cloud
- Self-hosted Jaeger
- Tier 4 SIEM bridges

The choice is config; the codebase is exporter-agnostic.

---

## 16. HA & deployment

### 16.1 Topology options

**Single VPS (Tier 1):**
- One Helix container with `HELIX_ROLES=all`
- One Postgres, one Redis, one NATS, one Meili, one RustFS, one Cerbos
- Caddy as edge
- All in one `docker-compose.yml`
- ~30 min setup including TLS

**Multi-host (Tier 2):**
- 2+ Helix replicas with role splitting:
  - `HELIX_ROLES=api,sync` on web tier (autoscale 2-5)
  - `HELIX_ROLES=smtp` on dedicated host (ports 25/587)
  - `HELIX_ROLES=worker` on worker tier (1-2 replicas; one is leader)
- Postgres on dedicated host (or managed RDS)
- NATS in 3-node cluster for JetStream replication
- Meili on dedicated host
- RustFS distributed mode or S3
- HAProxy/Caddy LB in front

**Kubernetes (Tier 3+):**
- Helm chart in `/infra/helm/helix/`
- StatefulSets for Postgres (via CloudNativePG operator), NATS, Meili, RustFS
- Deployments for Helix replicas, Cerbos, audit shipper
- HPA on Helix API and sync workloads (CPU + WebSocket connection metrics)
- PDBs ensuring minimum availability
- Network policies enforcing tier-mandated segmentation
- SPIRE for service identity
- Vault for secrets (via vault-secrets-operator or Vault Agent injector)

### 16.2 Leader election

Singleton workers (outbox poller, scheduled jobs, audit verifier) must run as a single instance even when multiple worker replicas exist. Implementation: Postgres advisory locks.

```typescript
// Each worker on startup:
const ok = await pg.tryAdvisoryLock('outbox-poller');
if (ok) { runOutboxPoller(); } else { /* I'm a standby; reattempt every 10s */ }
```

The lock releases on process exit (Postgres cleans up); standbys take over.

### 16.3 Graceful shutdown

On `SIGTERM`:

1. Stop accepting new HTTP requests (Caddy is informed via readiness probe going unhealthy)
2. Finish in-flight HTTP requests within a 30s grace period
3. For SMTP listener: stop accepting connections, finish in-flight messages
4. For Yjs sync: send "host shutting down" message, persist all dirty docs, close connections cleanly
5. For chat WebSocket: send "reconnect required" message, clients reconnect to a different replica
6. Drain NATS subscriptions
7. Release leader locks
8. Exit cleanly

Kubernetes `terminationGracePeriodSeconds` set to 60s.

### 16.4 Backup architecture

**What to back up:**

- **Postgres:** logical dumps daily + WAL archived continuously (PITR via `pg_basebackup` or CloudNativePG)
- **RustFS / S3:** versioning enabled; replicated to backup bucket; restic snapshots for cold archive
- **Cerbos policies:** in git (no separate backup; restore = clone repo)
- **Better-Auth data:** part of Postgres
- **Yjs documents:** part of Postgres (`docs_documents.ydoc_state` + `docs_updates`)
- **NATS JetStream:** consumer state matters only for ordering; if lost, replay from `activity` table
- **Meilisearch:** derived; rebuildable from Postgres via `helix reindex --all`
- **Configuration:** `/etc/helix/config.yaml` in git; `platform_config` in Postgres
- **Plugin state:** `installed_plugins` table + sideloaded plugin code volumes

**Where it goes:**

- Tier 1: local volumes + scp/restic to a remote
- Tier 2: encrypted (age) to S3 with versioning
- Tier 3: KMS-encrypted to S3 with Object Lock + cross-region replication
- Tier 4: HSM-backed encryption, WORM destination, cross-region replication

### 16.5 Restore runbook

`/docs/RUNBOOK.md` contains the exact step-by-step. Summary:

1. Provision target environment (matching tier)
2. Restore Postgres from latest base + WAL replay to chosen recovery target
3. Restore RustFS/S3 (or repoint to existing if cross-region replication)
4. Bring up Cerbos pointing to restored Postgres
5. Bring up Helix app — migrations are idempotent
6. `helix reindex --all` to rebuild Meilisearch
7. Verify activity log hash chain
8. Optional: replay outbox-undelivered events
9. Test critical paths (auth, send mail, search)
10. Switch DNS

CI runs a restore drill **nightly** via `infra/scripts/restore-drill.sh`. Failure alerts the team.

### 16.6 Disaster recovery targets

| Tier | RPO | RTO |
|---|---|---|
| Personal | 24h | 4h |
| Business | 1h | 1h |
| Enterprise | 15min | 15min |
| Sovereign | 5min | 15min (within perimeter) |

### 16.7 Helm chart

Located at `/infra/helm/helix/`. Values cover:

- Replica counts per role
- Tier setting (drives sidecar provisioning)
- Persistence sizes
- External service endpoints (Postgres, Vault, S3, KMS)
- Plugin enablement
- Ingress / service mesh integration
- Resource requests/limits
- HPA settings
- Network policies
- Pod security standards (restricted by default)

The chart is published to a Helm repository in the release pipeline.

---

## 17. Task list (build roadmap for AI loop)

Each task has dependencies, an outcome, and acceptance criteria. The agent picks the next undone task whose dependencies are complete.

**Phase ordering is strict.** Platform first. Core platform plugins next. AI foundation. Feature plugins (each as a plugin from day one). Hardening last. Don't skip ahead.

### Phase −1: Platform foundation (Weeks 1-4)

```
TASK-001  Initialize monorepo (pnpm workspaces + Turborepo, base configs)
TASK-002  Shared lint/format/tsconfig in packages/config
TASK-003  Docker Compose for local infra (Postgres+pgvector, Redis, NATS, Meili, RustFS, Cerbos, Caddy)
TASK-004  Platform DB schema (actors, objects, threads, messages, message_attachments, permissions, activity with hash chain, outbox, ai_artifacts, memory_items, pending_actions, app_passwords, platform_config, installed_plugins, agent_credentials)
TASK-005  Cerbos schema for platform resource kinds (object, thread, calendar, event, admin) and derived roles (owner, participant, shared, org_member)
TASK-006  Better-Auth integration as platform module; users sit in actors with type='user'
TASK-007  Fastify v5 server skeleton; OTel SDK init; pino logging; @fastify/swagger
TASK-008  tRPC mount; tRPC-OpenAPI adapter; OpenAPI generation pipeline
TASK-009  Vite + TanStack Router + Tailwind 4 + shadcn init with preset b1D0dv72; SDK consumption pattern; light/dark/system color mode bootstrap; ESLint rule banning native popups
TASK-010  @helix/sdk-types package: TypeScript types for all capability interfaces
TASK-011  @helix/sdk (server): PlatformHost, capability registries, lifecycle hook helpers
TASK-012  @helix/sdk-web: WebPlatformHost, registration hooks for UI contributions
TASK-013  Plugin loader: discover, validate manifest, resolve dependencies, load in-process modules
TASK-014  Plugin migration runner: per-plugin namespaced Drizzle migrations
TASK-015  Plugin lifecycle: onStart/onEnable/onDisable/onUninstall hooks
TASK-016  Capability registries: register/lookup/list with type safety
TASK-017  Configuration system: load YAML + env + Postgres overrides; tier engine; hot-reload via NATS
TASK-018  Audit table with hash chain; activity emission helper; daily verifier job
TASK-019  Outbox pattern: insert in tx, worker publishes to NATS, marks delivered
TASK-020  Leader election via Postgres advisory locks
TASK-021  Tool registry: ToolDefinition type, register, list (filtered by actor scopes/Cerbos), invoke
TASK-022  OAuth 2.1 client credentials: /oauth/token, scope validation, Better-Auth client management
TASK-023  Confirmation gate: pending_actions table, notification on creation, approve/deny flow
TASK-024  Agent rate/cost limiter: Redis sliding window, per-actor cost accounting
TASK-025  W3C Trace Context propagation through HTTP, NATS, WebSocket
TASK-026  Metrics registration helpers (prom-client); platform standard metrics exposed at /metrics
TASK-027  Shell UI: left rail, top bar, command palette (cmdk), notification bell, account chip — all plugin-extensible
TASK-028  Web SDK plugin loader: discover web plugins, register contributions
```

### Phase 0: Core platform plugins (Weeks 5-7)

```
TASK-100  com.helix.core.storage-rustfs — implements StorageProvider via RustFS
TASK-101  com.helix.core.search-meilisearch — implements SearchEngine; indexer event subscriber framework
TASK-102  com.helix.core-openapi — generates /openapi.json from routes + tools
TASK-103  com.helix.core-mcp-server — MCP server over /mcp, OAuth bearer auth
TASK-104  com.helix.core-asyncapi — generates /asyncapi.json from registered event schemas
TASK-105  com.helix.core-cli — `helix` CLI built from OpenAPI; install/auth/tool subcommands
TASK-106  com.helix.observability-otel — OTel SDK setup, exporters configured by config
TASK-107  com.helix.observability-grafana-stack — Compose recipe + dashboards JSON
TASK-108  com.helix.audit-immutable-s3 — audit shipper to S3 with Object Lock
TASK-109  com.helix.secrets-sops — SOPS-based secrets adapter
TASK-110  com.helix.webhook-engine — outbound delivery worker, inbound handler, HMAC sign/verify, deliveries table, admin tools
TASK-111  com.helix.webhook-out-generic — Helix native JSON envelope format
TASK-112  com.helix.webhook-out-slack — Slack incoming webhook format with template editor
TASK-113  com.helix.webhook-out-discord — Discord webhook format
TASK-114  com.helix.webhook-out-teams — Teams Adaptive Card format
TASK-115  com.helix.webhook-out-custom-template — Liquid/Handlebars template renderer
TASK-116  com.helix.webhook-in-generic — generic HMAC-SHA256 verification + routing engine
TASK-117  com.helix.webhook-in-github — GitHub-style signature verification + event payload parsing
TASK-118  com.helix.webhook-in-stripe — Stripe signature format (timestamp + signature pair)
TASK-119  com.helix.webhook-in-linear — Linear webhook source
TASK-120  Webhook admin UI — outbound/inbound/deliveries tabs with TanStack Table + TanStack Virtual
TASK-121  Tier 1 docker-compose.yml — brings up full Tier 1 stack (incl. webhook engine)
```

### Phase 1: AI foundation (Weeks 8-9)

```
TASK-200  LLMProvider capability interface + ai-routing service; chat() method with feature lookup, classification gating, fallback, cost accounting, audit
TASK-201  com.helix.ai-provider-openai-compatible — covers OpenAI, Azure, Ollama, vLLM, Groq, Together, etc.
TASK-202  com.helix.ai-provider-anthropic-compatible — direct Anthropic
TASK-203  com.helix.ai-provider-bedrock — SigV4 auth + Anthropic models on Bedrock
TASK-204  com.helix.ai-provider-vertex — GCP service account auth + Anthropic models on Vertex
TASK-205  EmbeddingProvider capability + com.helix.embedding-openai-compat
TASK-206  VectorStore capability interface
TASK-207  com.helix.vector-pgvector — pgvector-backed VectorStore (default)
TASK-208  com.helix.vector-qdrant — Qdrant-backed VectorStore
TASK-209  com.helix.vector-milvus — Milvus-backed VectorStore
TASK-210  com.helix.vector-chroma — Chroma-backed VectorStore
TASK-211  com.helix.vector-weaviate — Weaviate-backed VectorStore
TASK-212  SuggestionSlotProvider capability + slot rendering framework in web SDK
TASK-213  EnrichmentHandler capability + enrichment worker subscribed to activity.*
TASK-214  MemoryStore capability + per-actor memory (pgvector-backed default)
TASK-215  AI provenance tracking: ai_artifacts table writes, UI badge rendering
TASK-216  Classification system: resource tagging, derivation rules, gating enforcement
TASK-217  AI cost limit + audit dashboard integration
```

### Phase 2: Mail plugin (Weeks 10-12)

```
TASK-300  com.helix.core.mail — manifest, migrations (mail_filters, mail_aliases, mail_vacation)
TASK-301  In-process SMTP receiver (smtp-server) with mailauth (SPF/DKIM/DMARC); ingest pipeline writes message + attachments + outbox in one tx
TASK-302  Outbound mail via nodemailer + SES; undo-send via delayed outbox dispatch
TASK-303  Tools: mail.send, mail.reply, mail.label.apply, mail.archive, mail.delete, mail.snooze, mail.filter.create/update/delete, mail.search
TASK-304  Mail UI — list/reader/composer; TanStack Virtual for thread list; Tiptap composer; recipient chip combobox; label sidebar
TASK-305  Filters and vacation auto-responder
TASK-306  Mail indexer registered with search; AI suggestion slots wired (compose-help, summarize-thread, suggest-reply)
TASK-307  Mail enrichments (entity-extract, classification) opt-in
TASK-308  Mail E2E: send→receive→reply→label→search→filter→AI compose-help
```

### Phase 3: Chat plugin (Weeks 13-14)

```
TASK-400  com.helix.core.chat — manifest, migrations
TASK-401  Chat WebSocket route /ws/chat; NATS subjects per room; presence in Redis
TASK-402  Tools: chat.send, chat.react, chat.edit, chat.delete, chat.create_room, chat.invite, chat.search
TASK-403  Chat UI — room list, message stream, composer; reactions, edits, mentions
TASK-404  Typing indicators, presence, read receipts
TASK-405  Chat enrichments (action-items), AI slots (suggest-reply, summarize-room)
TASK-406  Chat E2E
```

### Phase 4: Drive plugin (Weeks 15-16)

```
TASK-500  com.helix.core.drive — manifest, migrations (drive_folders, drive_versions)
TASK-501  Tools: drive.upload, drive.finalize, drive.list, drive.share, drive.move, drive.trash, drive.restore, drive.delete, drive.search
TASK-502  Drive UI — grid/list, breadcrumb, multi-select, share dialog
TASK-503  Preview framework + first-party renderers (image, PDF, video, audio, text)
TASK-504  com.helix.drive-preview-libreoffice — Office → PDF preview (separate container)
TASK-505  Drive indexer, AI describe-image, summarize-file slots
TASK-506  Drive E2E
```

### Phase 5: Docs plugin (Weeks 17-18)

```
TASK-600  com.helix.core.docs — manifest, migrations (docs_documents, docs_updates, docs_comments)
TASK-601  In-API Yjs sync WS at /sync/docs/:docId; doc_updates append, debounced compaction
TASK-602  Tools: docs.create, docs.update-title, docs.export, docs.comment.create
TASK-603  Tiptap editor + Yjs collaboration; live cursors via awareness
TASK-604  Comments + suggestions
TASK-605  Export to PDF/DOCX/Markdown
TASK-606  AI slots (smart-write, summarize, translate); outline enrichment
TASK-607  Docs E2E
```

### Phase 6: Calendar plugin (Weeks 19-20)

```
TASK-700  com.helix.core.calendar — manifest, migrations (cal_calendars, cal_events, cal_attendees)
TASK-701  Tools: calendar.event.create/update/delete, calendar.event.respond, calendar.find-time
TASK-702  Calendar UI — week/month/day; drag-create, drag-move
TASK-703  CalDAV sub-app at /dav/cal/*
TASK-704  .ics invitations via mail plugin; RSVP via link
TASK-705  Free/busy + find-time
TASK-706  AI slots (suggest-meeting-time, draft-agenda)
TASK-707  Calendar E2E
```

### Phase 7: Meet plugin (Week 21)

```
TASK-800  com.helix.core.meet-jitsi — manifest, migrations (meet_rooms)
TASK-801  Tools: meet.create-room, meet.mint-token, meet.end-room
TASK-802  Jitsi compose stack at meet.<domain>; JWT minting from actor sessions
TASK-803  Meet UI integration in Helix shell (iframe + branded chrome)
TASK-804  Recording → objects → drive attachment on call thread
TASK-805  Meet E2E
```

### Phase 8: Helix Assistant (Week 22)

```
TASK-900  com.helix.core.assistant — manifest, migrations
TASK-901  Assistant UI — right-rail panel + /assistant full page; Tiptap chat history; tool-call cards with confirm/cancel; citation chips; provenance details
TASK-902  Backend orchestration: LLM via ai-routing → tool calls via tool registry → context via search + memory
TASK-903  Slash commands: /draft, /summarize, /find, /schedule
TASK-904  Conversation persistence with opt-in memory; "forget" flow
TASK-905  Assistant E2E (multi-turn with tool calls and confirmations)
```

### Phase 9: Hardening (Weeks 23-26)

```
TASK-A00  Tier 2 hardening: mTLS internal (Caddy upstream TLS), SSE-S3 for storage, age-encrypted backups, MFA required for admins, audit shipping to immutable S3
TASK-A01  Tier 3 hardening: SPIRE for service identity, Vault for secrets (mandatory), TDE for Postgres, HA Postgres via CloudNativePG, SIEM bridge
TASK-A02  Tier 4 spec & adapter scaffolding: FIPS crypto adapter interfaces, STIG image variants, NIST 800-53 control mapping doc, air-gap install guide
TASK-A03  Helm chart for Helix; values for tiers; HPA + PDB + NetworkPolicy
TASK-A04  Backup architecture impl: per-tier backup workflows; restore runbook (RUNBOOK.md)
TASK-A05  CI restore drill: nightly script that restores prior day's backup into clean stack and verifies critical paths
TASK-A06  Mobile responsive pass across all routes
TASK-A07  Accessibility audit (axe-core in CI, WCAG 2.2 AA)
TASK-A08  Final visual pass: verify every plugin's surfaces respect the preset's visual identity; consistency review across mail/chat/drive/docs/calendar/meet/assistant/admin; verify both light and dark modes; verify reduced-motion respected
TASK-A09  Load testing (k6 scenarios) against targets in Section 2.2
TASK-A10  Documentation pass: PRD references, plugin author guide, admin guide, runbook, troubleshooting
```

---

## 18. Open questions for human review

Park here; don't resolve unilaterally:

1. **Brand & domain** — "Helix" is working name
2. **License** — Apache 2.0 vs. AGPL-3.0 vs. dual-license (impacts plugin marketplace)
3. **Multi-tenant in v2** — design v1 hooks now, or strict single-org?
4. **Native mobile** — Capacitor wrapper vs. React Native vs. defer
5. **E2EE chat in v1.5** — when to actually implement (schema is forward-compat)
6. **Federation** — Matrix bridge? ActivityPub? JMAP-only?
7. **Plugin marketplace / registry** — Helix-hosted vs. self-hosted-only vs. defer
8. **WASM plugins** — when to add (interfaces designed-for in v1; impl post-v1)
9. **Sovereign tier impl timeline** — spec'd in v1.3; when do we actually ship FIPS adapters and STIG images?
10. **Conversational assistant defaults** — which model to default to? Likely "whatever the admin configured first"

---

## 19. Appendix

### 19.1 Reference reading

- Plugin architecture patterns: https://medium.com/cocoaacademymag/scaling-typescript-plugin-systems-...
- Backstage plugin model (inspiration): https://backstage.io/docs/plugins/
- VS Code extension model: https://code.visualstudio.com/api
- Strapi plugin SDK: https://docs.strapi.io/dev-docs/plugins/development/create-a-plugin
- Model Context Protocol: https://modelcontextprotocol.io/
- OpenAPI 3.1 spec: https://spec.openapis.org/oas/v3.1.0
- AsyncAPI 3.0: https://www.asyncapi.com/docs/reference/specification/v3.0.0
- OAuth 2.1 draft: https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/
- OpenTelemetry semantic conventions for GenAI: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Cerbos policy authoring: https://docs.cerbos.dev/cerbos/latest/policies/
- NIST 800-53 Rev 5: https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final
- DISA STIGs: https://public.cyber.mil/stigs/
- SPIFFE/SPIRE: https://spiffe.io/
- HashiCorp Vault: https://developer.hashicorp.com/vault/docs
- CloudNativePG: https://cloudnative-pg.io/documentation/current/
- Better-Auth: https://www.better-auth.com/docs
- Fastify: https://fastify.dev/docs/latest/
- TanStack: https://tanstack.com/
- Tiptap collaboration: https://tiptap.dev/docs/collaboration
- Yjs sync protocol: https://github.com/yjs/y-protocols
- shadcn/ui: https://ui.shadcn.com/
- shadcn registry & presets: https://ui.shadcn.com/docs/registry
- Tailwind 4: https://tailwindcss.com/blog/tailwindcss-v4
- Jitsi self-hosting: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker
- Mediasoup (v2 video plan): https://mediasoup.org/documentation/v3/
- AWS SES: https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html
- Smtp-server library: https://nodemailer.com/extras/smtp-server/

### 19.2 Glossary

- **Capability:** a typed extension point in the platform that plugins implement or consume
- **Plugin:** a self-contained directory of code + manifest that extends Helix via capabilities
- **Actor:** any principal (human, service account, agent, system) that takes action
- **Tool:** a registered platform action invocable via tRPC, REST, MCP, and LLM tool-use
- **Tier:** Personal / Business / Enterprise / Sovereign — bundled default security settings
- **Classification:** public / standard / confidential / restricted — applied to resources, gates AI routing
- **Provenance:** metadata tracking AI-generated content origin (provider, model, prompt hash, etc.)
- **Outbox pattern:** atomic publishing — write event in same transaction as state change; background worker publishes to NATS
- **Hash chain:** each audit row includes hash of previous, enabling tamper detection
- **Routing (AI):** platform-managed mapping of feature → provider+model with fallback and classification gating
- **Suggestion slot:** UI surface where AI plugins can contribute content (composer help, summarize, etc.)
- **Enrichment:** background AI-produced augmentation of an entity (mail summary, image caption)
- **MCP:** Model Context Protocol — Anthropic's open protocol for exposing tools to LLM clients
- **PDP / PEP:** Policy Decision Point (Cerbos) / Policy Enforcement Point (the API)

### 19.3 Example: "share a Drive file into a chat, with assistant help" end-to-end

A worked example showing how all layers cooperate. The user types "@helix share the Q3 report with #engineering" in the assistant.

1. **Assistant UI** (`com.helix.core.assistant`) sends user message to backend
2. **Assistant backend** calls `host.capabilities.ai.chat({ feature: 'assistant.chat', messages, tools: [...] })`
3. **ai-routing** consults config: feature `assistant.chat` → primary `anthropic-prod / claude-3-5-sonnet`. Classification of the conversation is `standard`. Provider is allowed.
4. **LLM call** goes out with tool catalog filtered by actor's scopes (the user has `drive.read`, `drive.share`, `chat.post`)
5. Provider returns tool calls: `drive.search({query: "Q3 report"})` then `drive.share({objectId: ..., principals: [{type:'org',id:'engineering'}]})` then `chat.send({roomId:'engineering', body:'Sharing Q3 report'})`
6. **Each tool call:**
   - Audit row inserted with `actor_type=user`, `on_behalf_of=user`, `tool_id`, `trace_id`
   - Cerbos check (passes for `drive.search` immediately; `drive.share` and `chat.send` are `external_communication`+`write` → confirmation required by tier policy)
   - Pending action created; notification fires to the user with confirm/cancel UI
   - User clicks confirm
   - Tool handler executes; permission row inserted in `permissions`; activity row + outbox; assistant continues
7. **Search** for "Q3 report" — semantic-augmented if vector store configured; results filtered by Cerbos to what the user can see
8. **Share** widens the permission row from owner-only to org-readable; activity emitted
9. **Chat.send** posts message with file attachment chip (reusing the same `objects` row, no copy)
10. **Indexer** picks up the chat message; vectorizer (if configured) embeds and stores in vector store
11. **Notifications** fire to room members
12. **OTel** captured the full sequence: one trace with spans for assistant, LLM call (with tokens/cost), each tool call, each Cerbos check, each DB transaction, the embedding call, the notification fan-out
13. **`activity` rows** for the LLM call, three tool invocations, two permission grants, and the chat send — all linked by `trace_id`
14. **Dashboards** show the activity in the AI dashboard (one LLM call, three tool calls), the agent dashboard (zero — this was a user via assistant, not an agent), the search dashboard (semantic query)

The file was never copied. Permission widened by one row. The renderer for the preview is the same Drive renderer. One indexer indexed both the chat message and the original file under the same query. The same Cerbos policy governed every access check. The same audit chain captured every step. One trace tied everything together.

---

**End of PRD v1.3.**
