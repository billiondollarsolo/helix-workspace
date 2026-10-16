import { workspaceCommandUsage } from "./workspace-commands.js";

const workspaceLines = (scope: string) =>
  (workspaceCommandUsage[scope] ?? []).map((line) => `  ${line}`).join("\n");

/** Full CLI help text, printed by `helix --help` and after usage errors. */
export const usage = `Usage:
  helix events watch --cursor-file <path> [--handler <executable>] [--all] [--after <cursor>]
  helix --version
  helix tool list [--source <api|openapi|mcp>]
  helix tool describe <id>
  helix tool call <id> [--transport <rest|mcp>] [--json [JSON]]
  helix search <query>
  helix search --query <text> [--type <mail|chat|drive|calendar>] [--limit <number>] [--json [JSON]]
  helix mail send [--to <email>] [--cc <email>] [--bcc <email>] [--from <email>] [--subject <text>] [--body <text>] [--html <html>] [--json [JSON]]
  helix mail reply [--thread-id <id>] [--message-id <id>] [--to <email>] [--cc <email>] [--bcc <email>] [--body <text>] [--html <html>] [--json [JSON]]
  helix mail forward [--thread-id <id>] [--message-id <id>] [--to <email>] [--cc <email>] [--bcc <email>] [--subject <text>] [--body <text>] [--json [JSON]]
  helix mail list [--folder <inbox|starred|snoozed|sent|scheduled|drafts|all|archive|spam|trash>] [--tab <primary|updates|promotions|social>] [--label <label>] [--query <text>] [--limit <number>] [--offset <number>] [--mailbox-actor-id <id>] [--json [JSON]]
  helix mail search [--query <text>] [--label <label>] [--limit <number>] [--mailbox-actor-id <id>] [--json [JSON]]
  helix mail label [--thread-id <id>] [--add <label>] [--remove <label>] [--json [JSON]]
  helix mail archive [--thread-id <id>] [--json [JSON]]
  helix mail delete [--thread-id <id>] [--json [JSON]]
  helix mail snooze [--thread-id <id>] [--until <iso>] [--json [JSON]]
  helix mail read [--thread-id <id>] [--unread] [--json [JSON]]
  helix mail star [--thread-id <id>] [--starred] [--unstarred] [--json [JSON]]
  helix mail thread-get [--thread-id <id>] [--json [JSON]]
  helix mail filter-create [--name <name>] [--priority <number>] [--enabled] [--disabled] [--criteria <json-object>] [--actions <json-object>] [--json [JSON]]
  helix mail filter-update [--id <id>] [--name <name>] [--priority <number>] [--enabled] [--disabled] [--criteria <json-object>] [--actions <json-object>] [--json [JSON]]
  helix mail filter-delete [--id <id>] [--json [JSON]]
  helix mail vacation-get [--json [JSON]]
  helix mail vacation-set [--enabled] [--disabled] [--subject <text>] [--body <text>] [--start <iso>] [--end <iso>] [--json [JSON]]
${workspaceLines("mail")}
  helix chat send [--room-id <id>] [--body <text>] [--text <text>] [--json [JSON]]
  helix chat react [--json [JSON]]
  helix chat edit [--json [JSON]]
  helix chat delete [--json [JSON]]
  helix chat create-room [--name <name>] [--subject <text>] [--description <text>] [--topic <text>] [--member <actor-id>] [--kind <chat_room|chat_dm>] [--privacy <discoverable|restricted|private>] [--json [JSON]]
  helix chat dm --json '{"memberActorIds":["<actor-id>"]}'
  helix chat invite [--json [JSON]]
  helix chat search [--query <text>] [--room-id <id>] [--limit <number>] [--json [JSON]]
  helix chat messages [--room-id <id>] [--before <iso>] [--limit <number>] [--json [JSON]]
${workspaceLines("chat")}
${workspaceLines("contacts")}
${workspaceLines("account")}
  helix drive upload <path> [--prepared <json-file>] [--folder <folder-id>] [--name <name>] [--mime-type <type>] [--byte-size <number>] [--sha256 <hex>] [--json [JSON]]
  helix drive finalize [--json [JSON]]
  helix drive list [--folder <folder-id>] [--limit <number>] [--include-trashed] [--json [JSON]]
  helix drive share [--json [JSON]]
  helix drive move [--json [JSON]]
  helix drive trash [--json [JSON]]
  helix drive restore [--json [JSON]]
  helix drive delete [--json [JSON]]
  helix drive search [--query <text>] [--folder <folder-id>] [--limit <number>] [--json [JSON]]
  helix drive s3-keys list [--include-revoked] [--all] [--json [JSON]]
  helix drive s3-keys revoke --key-id <id> [--json [JSON]]
  helix calendar event-create [--calendar-id <id>] [--title <text>] [--description <text>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--location <text>] [--attendee <email>] [--all-day] [--json [JSON]]
  helix calendar event-update [--event-id <id>] [--calendar-id <id>] [--title <text>] [--description <text>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--location <text>] [--attendee <email>] [--all-day] [--json [JSON]]
  helix calendar event-delete [--event-id <id>] [--send-cancellation] [--json [JSON]]
  helix calendar event-respond [--event-id <id>] [--response <accepted|declined|tentative>] [--json [JSON]]
  helix calendar event-list [--calendar-id <id>] [--start <iso>] [--end <iso>] [--limit <number>] [--json [JSON]]
  helix calendar find-time [--attendee <email>] [--attendee-email <email>] [--attendee-actor-id <id>] [--duration-minutes <number>] [--step-minutes <number>] [--limit <number>] [--start <iso>] [--end <iso>] [--json [JSON]]
${workspaceLines("calendar")}
  helix webhook outbound create [--name <name>] [--url <url>] [--secret <secret>] [--event-subject <subject>] [--header <name=value>] [--headers <json-object>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook outbound update [--id <id>] [--name <name>] [--url <url>] [--secret <secret>] [--event-subject <subject>] [--header <name=value>] [--headers <json-object>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook outbound delete [--id <id>] [--json [JSON]]
  helix webhook outbound list [--json [JSON]]
  helix webhook outbound test [--id <id>] [--subject <subject>] [--payload <json>] [--json [JSON]]
  helix webhook outbound replay [--delivery-id <id>] [--id <id>] [--json [JSON]]
  helix webhook inbound create [--name <name>] [--slug <slug>] [--source <source>] [--secret <secret>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook inbound update [--id <id>] [--name <name>] [--slug <slug>] [--source <source>] [--secret <secret>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook inbound delete [--id <id>] [--json [JSON]]
  helix webhook inbound rotate-secret [--id <id>] [--secret <secret>] [--json [JSON]]
  helix webhook inbound list [--json [JSON]]
  helix webhook delivery get [--id <id>] [--json [JSON]]
  helix webhook delivery list [--direction <outbound|inbound>] [--status <pending|in_progress|delivered|failed|abandoned>] [--limit <number>] [--json [JSON]]
  helix admin app-passwords list [--actor-id <id>] [--include-revoked] [--json [JSON]]
  helix admin app-passwords create [--actor-id <id>] [--label <label>] [--scope <scope>] [--expires-at <iso>] [--json [JSON]]
  helix admin app-passwords revoke [--password-id <id>] [--json [JSON]]
  helix admin agent-credentials list [--actor-id <id>] [--include-revoked] [--json [JSON]]
  helix admin agent-credentials create --actor-id <id> --credential-type <api_key|oauth_client|mtls_cert> --label <label> --purpose <purpose> --scope <scope> [--expires-at <iso>] [--json [JSON]]
  helix admin agent-credentials revoke --credential-id <id> [--json [JSON]]
  helix admin users list [--query <text>] [--type <user|agent|service_account|system>] [--include-disabled] [--limit <number>] [--cursor <cursor>]
  helix admin users <suspend|restore> --actor-id <id>
  helix admin users invite --email <email> [--name <name>] [--admin]
  helix admin users <resend-invite|revoke-invite> --actor-id <id>
  helix admin audit list [--actor-id <id>] [--object-id <id>] [--object-type <type>] [--verb <verb>] [--limit <number>] [--cursor <cursor>]
  helix backup create
  helix restore --from <backup-id> --target-db <isolated-db> --target-bucket <isolated-bucket> --idempotency-key <key> [--encrypted]
  helix reindex --all [--max-wait <seconds>]
  helix reindex --status <job-id>
  helix action status <action-id>
  helix action approve <action-id>
  helix action cancel <action-id>
  helix tier set <personal|business|enterprise|sovereign>
  helix assistant chat [--json [JSON]]
  helix assistant new [--json [JSON]]
  helix assistant forget [--json [JSON]]
  helix assistant approve [--conversation-id <id>] [--pending-id <id>] [--json [JSON]]
  helix assistant cancel [--conversation-id <id>] [--pending-id <id>] [--json [JSON]]
  helix login --client-id <id> --client-secret <secret> [--scope <scopes>]
  helix logout
  helix auth token --client-id <id> --client-secret <secret> [--scope <scopes>]
  helix openapi get
  helix asyncapi get
  helix mcp serve
  helix mcp resources list
  helix mcp resources read <uri>
  helix completion <bash|zsh|fish>

Environment:
  HELIX_BASE_URL         Base URL for the Helix API
  HELIX_ACCESS_TOKEN     Optional bearer token for API requests
  HELIX_API_KEY          API key for the agent identity (takes precedence over HELIX_ACCESS_TOKEN)
  HELIX_CREDENTIALS_FILE Override path for stored credentials (helix logout)
  HELIX_TIMEOUT          Per-request timeout in seconds (default 120; same as --timeout)

Global options (accepted before or after the command):
  --timeout <seconds>        Per-request timeout. Storage uploads also get time proportional to their size.
  --idempotency-key <key>    Idempotency-Key for tool calls (default: a fresh UUID per invocation, reused on retries)
  --output <text|json>       With json, errors are written to stderr as {"error":{...}}
  -h, --help                 Show help; "helix <command> --help" shows only that command

JSON input: --json takes a JSON object inline or, without a value, from stdin. Commands with
flags accept both together: the JSON is the base and each flag sets (and overrides) its field.

Retries: 429 responses are retried up to 3 times with exponential backoff that honours Retry-After;
503 responses and network errors are retried for reads and for tool calls carrying an Idempotency-Key.

Exit codes:
  0  Success
  1  Other failure (bad request, conflict, server error)
  2  Usage error (unknown command or flag, invalid --json input)
  3  Authentication or authorization failure (HTTP 401/403)
  4  Not found (HTTP 404)
  5  Rate limited after retries (HTTP 429)
  6  Pending confirmation (HTTP 202): approve with "helix action approve <action-id>"
  7  Network failure or timeout`;

const commandLines = usage
  .split("\n")
  .filter((line) => line.startsWith("  helix "))
  .map((line) => line.trim());
const helpSections = usage.slice(usage.indexOf("\n\nEnvironment:"));

/**
 * Help scoped to a command prefix such as `["mail"]` or `["mail", "send"]`.
 * Falls back to shorter prefixes, then to the full usage, when nothing matches.
 */
export function scopedUsage(words: readonly string[]): string {
  for (let length = words.length; length > 0; length -= 1) {
    const prefix = `helix ${words.slice(0, length).join(" ")}`;
    const matches = commandLines.filter((line) => line === prefix || line.startsWith(`${prefix} `));
    if (matches.length > 0) {
      return `Usage:\n${matches.map((line) => `  ${line}`).join("\n")}${helpSections}`;
    }
  }
  return usage;
}
