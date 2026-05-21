# Helix Assistant Plugin

`com.helix.core.assistant` declares the first-party assistant surface for Helix: model-routed assistant calls, thread summarization, explicit memory controls, UI contributions, policy metadata, and assistant-specific persistence.

## Manifest Surface

The plugin contributes assistant tools through the platform tool registry:

- `assistant.ask` for contextual assistant responses.
- `assistant.summarize-thread` for thread summaries.
- `assistant.remember` for confirmed actor-scoped memory writes.
- `assistant.forget` for confirmed memory deletion or expiry.
- `assistant.memory-status` for reading the current actor's memory preference.

The manifest also advertises `/assistant`, a right-rail assistant panel, command palette entries, settings pages, and `apiSurface` metadata that maps assistant tools onto `/api/tools`.

## Configuration

`config.schema.json` keeps model behavior and memory policy explicit:

- `defaultModel` is optional. When unset, `ai-routing` should use the provider default model.
- `modelSelection.mode` defaults to `provider-default` with per-request user override allowed.
- `memory.requiresExplicitOptIn` is fixed to `true`.
- `memory.enabledByDefault` defaults to `false`.
- `memory.retentionDays` defaults to `365` and may be set to `null` for deletion-only retention.

Environment-backed manifest config keys are `ASSISTANT_DEFAULT_MODEL`, `ASSISTANT_MEMORY_ENABLED_DEFAULT`, `ASSISTANT_MEMORY_RETENTION_DAYS`, `ASSISTANT_MAX_CONTEXT_MESSAGES`, and `ASSISTANT_MAX_OUTPUT_TOKENS`.

## Persistence

`migrations/001_assistant_core.sql` adds:

- `assistant_actor_preferences` for memory opt-in and actor model preferences.
- `assistant_sessions` for assistant conversation/session metadata.
- `assistant_runs` for invocation status, model metadata, pending action links, and artifact links.
- An assistant-scoped index on existing `memory_items` rows whose source starts with `assistant.`.

The migration references existing platform tables (`actors`, `threads`, `messages`, `pending_actions`, `ai_artifacts`, and `memory_items`) and does not alter runtime code.

## Policy

`policies/assistant.yaml` follows the Cerbos resource policy pattern used by platform resources. Admins can manage all assistant actions, org members can ask and summarize, and memory actions are owner-scoped and denied unless resource attributes indicate memory is enabled.
