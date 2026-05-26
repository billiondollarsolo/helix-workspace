import type { CompletionShell } from "./parser.js";

const topLevelCommands = [
  "tool",
  "mail",
  "chat",
  "drive",
  "docs",
  "calendar",
  "meet",
  "assistant",
  "webhook",
  "search",
  "admin",
  "backup",
  "restore",
  "reindex",
  "action",
  "tier",
  "login",
  "logout",
  "auth",
  "install",
  "plugin",
  "openapi",
  "asyncapi",
  "mcp",
  "completion",
] as const;

/**
 * Canonical registry of every CLI scope and its subcommands. Both the shell
 * completion scripts and the parser-agreement test consume this, so a new
 * subcommand cannot ship in the parser without also being completable (the
 * `parser.test.ts` drift test fails otherwise).
 */
export const commandActions: Record<string, readonly string[]> = {
  tool: ["list", "describe", "call"],
  mail: [
    "send",
    "reply",
    "list",
    "search",
    "label",
    "archive",
    "delete",
    "snooze",
    "read",
    "star",
    "thread-get",
    "thread",
    "filter-create",
    "filter-update",
    "filter-delete",
    "vacation-get",
    "vacation-set",
  ],
  chat: [
    "send",
    "react",
    "edit",
    "delete",
    "create-room",
    "invite",
    "search",
    "list",
    "messages",
    "message-list",
  ],
  drive: ["upload", "finalize", "list", "share", "move", "trash", "restore", "delete", "search"],
  docs: ["create", "get", "list", "update-title", "export", "comment-create", "comment"],
  calendar: [
    "event-create",
    "create",
    "event-update",
    "update",
    "event-delete",
    "delete",
    "event-respond",
    "respond",
    "event-list",
    "list",
    "find-time",
  ],
  meet: ["create-room", "create", "list", "rooms", "mint-token", "token", "end-room", "end"],
  assistant: [
    "chat",
    "ask",
    "new",
    "conversation-create",
    "forget",
    "memory-forget",
    "approve",
    "confirmation-approve",
    "cancel",
    "confirmation-cancel",
  ],
  webhook: ["outbound", "inbound", "delivery"],
  search: ["--query", "--type", "--limit", "--json"],
  admin: [
    "app-passwords",
    "agent-credentials",
    "credentials",
    "users",
    "audit",
    "audit-log",
    "storage",
    "storage-migrations",
    "tenant-exports",
  ],
  backup: ["create"],
  restore: ["--from", "--encrypted"],
  reindex: ["--all"],
  action: ["status", "approve", "cancel"],
  tier: ["set"],
  logout: [],
  auth: ["token"],
  install: ["list", "plugin", "enable", "disable", "uninstall"],
  plugin: ["install", "enable", "disable", "uninstall"],
  openapi: ["get"],
  asyncapi: ["get"],
  mcp: ["serve", "resources"],
  completion: ["bash", "zsh", "fish"],
};

// Scopes whose only completion is the generic `--json` flag.
const jsonScopes = ["install", "plugin"] as const;

const searchFlags = ["--query", "--type", "--limit", "--json"] as const;
const securityTierValues = ["personal", "business", "enterprise", "sovereign"] as const;
const storageMigrationTargetValues = ["byo", "helix-default"] as const;
const storageMigrationStatusValues = [
  "queued",
  "running",
  "succeeded",
  "succeeded_with_errors",
  "failed",
  "dry_run",
] as const;
const tenantExportJobStatusValues = ["queued", "running", "succeeded", "failed"] as const;

const mailActionFlags: Record<string, readonly string[]> = {
  send: ["--to", "--cc", "--bcc", "--from", "--subject", "--body", "--html", "--json"],
  reply: ["--thread-id", "--message-id", "--body", "--html", "--cc", "--bcc", "--json"],
  list: ["--mailbox", "--label", "--limit", "--cursor", "--json"],
  search: ["--query", "--mailbox", "--label", "--limit", "--cursor", "--json"],
  label: ["--thread-id", "--add", "--remove", "--json"],
  archive: ["--thread-id", "--json"],
  delete: ["--thread-id", "--json"],
  snooze: ["--thread-id", "--until", "--json"],
  read: ["--thread-id", "--unread", "--json"],
  star: ["--thread-id", "--starred", "--unstarred", "--json"],
  "thread-get": ["--thread-id", "--json"],
  thread: ["--thread-id", "--json"],
  "filter-create": [
    "--name",
    "--priority",
    "--enabled",
    "--disabled",
    "--criteria",
    "--actions",
    "--json",
  ],
  "filter-update": [
    "--id",
    "--name",
    "--priority",
    "--enabled",
    "--disabled",
    "--criteria",
    "--actions",
    "--json",
  ],
  "filter-delete": ["--id", "--json"],
  "vacation-get": ["--json"],
  "vacation-set": ["--enabled", "--disabled", "--subject", "--body", "--start", "--end", "--json"],
};

const chatActionFlags: Record<string, readonly string[]> = {
  send: ["--room-id", "--body", "--text", "--json"],
  "create-room": [
    "--name",
    "--subject",
    "--description",
    "--topic",
    "--member",
    "--kind",
    "--private",
    "--json",
  ],
  search: ["--query", "--room-id", "--limit", "--cursor", "--json"],
  list: ["--query", "--room-id", "--limit", "--cursor", "--json"],
  messages: ["--room-id", "--before", "--limit", "--json"],
  "message-list": ["--room-id", "--before", "--limit", "--json"],
};

const driveActionFlags: Record<string, readonly string[]> = {
  upload: ["--folder", "--name", "--mime-type", "--byte-size", "--sha256", "--json"],
  list: ["--folder", "--limit", "--include-trashed", "--json"],
  search: ["--query", "--folder", "--limit", "--json"],
};

const docsActionFlags: Record<string, readonly string[]> = {
  create: ["--title", "--initial-markdown", "--folder", "--folder-id", "--metadata", "--json"],
  get: ["--doc-id", "--json"],
  list: ["--query", "--limit", "--json"],
  "update-title": ["--doc-id", "--title", "--json"],
  export: ["--doc-id", "--format", "--include-comments", "--filename", "--json"],
  "comment-create": ["--doc-id", "--body", "--anchor", "--metadata", "--json"],
  comment: ["--doc-id", "--body", "--anchor", "--metadata", "--json"],
};

const calendarActionFlags: Record<string, readonly string[]> = {
  "event-create": [
    "--calendar-id",
    "--title",
    "--description",
    "--start",
    "--end",
    "--timezone",
    "--location",
    "--attendee",
    "--all-day",
    "--json",
  ],
  create: [
    "--calendar-id",
    "--title",
    "--description",
    "--start",
    "--end",
    "--timezone",
    "--location",
    "--attendee",
    "--json",
  ],
  "event-update": [
    "--event-id",
    "--calendar-id",
    "--title",
    "--description",
    "--start",
    "--end",
    "--timezone",
    "--location",
    "--attendee",
    "--json",
  ],
  update: [
    "--event-id",
    "--calendar-id",
    "--title",
    "--description",
    "--start",
    "--end",
    "--timezone",
    "--location",
    "--attendee",
    "--all-day",
    "--json",
  ],
  "event-delete": ["--event-id", "--send-cancellation", "--json"],
  delete: ["--event-id", "--send-cancellation", "--json"],
  "event-respond": ["--event-id", "--attendee-email", "--rsvp-token", "--response", "--json"],
  respond: ["--event-id", "--attendee-email", "--rsvp-token", "--response", "--json"],
  "event-list": ["--calendar-id", "--start", "--end", "--limit", "--json"],
  list: ["--calendar-id", "--start", "--end", "--limit", "--json"],
  "find-time": [
    "--attendee",
    "--attendee-email",
    "--attendee-actor-id",
    "--duration-minutes",
    "--step-minutes",
    "--limit",
    "--start",
    "--end",
    "--json",
  ],
};

const meetActionFlags: Record<string, readonly string[]> = {
  "create-room": [
    "--subject",
    "--room-name",
    "--jitsi-domain",
    "--participant",
    "--participant-actor-id",
    "--json",
  ],
  create: [
    "--subject",
    "--room-name",
    "--jitsi-domain",
    "--participant",
    "--participant-actor-id",
    "--json",
  ],
  list: ["--status", "--limit", "--json"],
  rooms: ["--status", "--limit", "--json"],
  "mint-token": ["--room-id", "--expires-in-seconds", "--moderator", "--json"],
  token: ["--room-id", "--expires-in-seconds", "--moderator", "--json"],
  "end-room": ["--room-id", "--json"],
  end: ["--room-id", "--json"],
};

const assistantClassificationValues = ["public", "standard", "confidential", "restricted"] as const;

const assistantActionFlags: Record<string, readonly string[]> = {
  chat: ["--json"],
  ask: ["--json"],
  new: ["--json"],
  "conversation-create": ["--json"],
  forget: ["--json"],
  "memory-forget": ["--json"],
  approve: ["--conversation-id", "--pending-id", "--classification", "--json"],
  "confirmation-approve": ["--conversation-id", "--pending-id", "--classification", "--json"],
  cancel: ["--conversation-id", "--pending-id", "--classification", "--json"],
  "confirmation-cancel": ["--conversation-id", "--pending-id", "--classification", "--json"],
};

const webhookFamilyActions: Record<string, readonly string[]> = {
  outbound: ["create", "update", "delete", "list", "test", "replay"],
  inbound: ["create", "update", "delete", "rotate-secret", "list"],
  delivery: ["get", "list"],
};

const webhookActionFlags: Record<string, readonly string[]> = {
  "outbound:create": [
    "--name",
    "--url",
    "--event-subject",
    "--secret-ref",
    "--header",
    "--headers",
    "--metadata",
    "--enabled",
    "--disabled",
    "--json",
  ],
  "outbound:update": [
    "--id",
    "--name",
    "--url",
    "--event-subject",
    "--secret-ref",
    "--header",
    "--headers",
    "--metadata",
    "--enabled",
    "--disabled",
    "--json",
  ],
  "outbound:delete": ["--id", "--json"],
  "outbound:list": ["--json"],
  "outbound:test": ["--id", "--subject", "--payload", "--json"],
  "outbound:replay": ["--delivery-id", "--id", "--json"],
  "inbound:create": [
    "--name",
    "--slug",
    "--source",
    "--secret-ref",
    "--metadata",
    "--enabled",
    "--disabled",
    "--json",
  ],
  "inbound:update": [
    "--id",
    "--name",
    "--slug",
    "--source",
    "--secret-ref",
    "--metadata",
    "--enabled",
    "--disabled",
    "--json",
  ],
  "inbound:delete": ["--id", "--json"],
  "inbound:rotate-secret": ["--id", "--json"],
  "inbound:list": ["--json"],
  "delivery:get": ["--id", "--json"],
  "delivery:list": ["--direction", "--status", "--limit", "--json"],
};

const adminFamilyActions: Record<string, readonly string[]> = {
  "app-passwords": ["list", "create", "revoke"],
  "agent-credentials": ["list", "create", "revoke"],
  credentials: ["list", "create", "revoke"],
  users: ["list"],
  audit: ["list"],
  "audit-log": ["list"],
  storage: ["test"],
  "storage-migrations": ["list", "request", "get", "status", "cutover"],
  "tenant-exports": ["queue", "list", "get", "status"],
};

const adminActionFlags: Record<string, readonly string[]> = {
  "app-passwords:list": ["--actor-id", "--include-revoked", "--json"],
  "app-passwords:create": ["--actor-id", "--label", "--scope", "--expires-at", "--json"],
  "app-passwords:revoke": ["--password-id", "--json"],
  "agent-credentials:list": ["--actor-id", "--include-revoked", "--json"],
  "agent-credentials:create": ["--actor-id", "--scope", "--expires-at", "--json"],
  "agent-credentials:revoke": ["--client-id", "--json"],
  "credentials:list": ["--actor-id", "--include-revoked", "--json"],
  "credentials:create": ["--actor-id", "--scope", "--expires-at", "--json"],
  "credentials:revoke": ["--client-id", "--json"],
  "users:list": ["--query", "--type", "--include-disabled", "--limit", "--cursor"],
  "audit:list": ["--actor-id", "--object-id", "--object-type", "--verb", "--limit", "--cursor"],
  "audit-log:list": ["--actor-id", "--object-id", "--object-type", "--verb", "--limit", "--cursor"],
  "storage:test": [],
  "storage-migrations:list": ["--target", "--status", "--limit", "--cursor"],
  "storage-migrations:request": [
    "--target",
    "--dry-run",
    "--live",
    "--confirm",
    "--source-storage",
    "--target-storage",
  ],
  "storage-migrations:get": [],
  "storage-migrations:status": [],
  "storage-migrations:cutover": ["--confirm"],
  "tenant-exports:queue": [
    "--include-object-bytes",
    "--metadata-only",
    "--presigned-url-expires-seconds",
  ],
  "tenant-exports:list": ["--status", "--limit", "--cursor"],
  "tenant-exports:get": [],
  "tenant-exports:status": [],
};

const dynamicToolIdsScript = String.raw`command helix tool list --source openapi 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { try { const parsed = JSON.parse(input); for (const tool of Array.isArray(parsed.tools) ? parsed.tools : []) { if (tool && typeof tool.id === "string") console.log(tool.id); } } catch {} });'`;

export function generateCompletionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion();
    case "zsh":
      return generateZshCompletion();
    case "fish":
      return generateFishCompletion();
  }
}

function generateBashCompletion(): string {
  return [
    "# bash completion for helix",
    "_helix_tool_ids() {",
    `  ${dynamicToolIdsScript}`,
    "}",
    "",
    "_helix_completion() {",
    "  local cur prev scope action",
    "  COMPREPLY=()",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  scope="${COMP_WORDS[1]}"',
    '  action="${COMP_WORDS[2]}"',
    "",
    '  case "$prev" in',
    `    --source) COMPREPLY=( $(compgen -W "${wordList(["api", "openapi", "mcp"])}" -- "$cur") ); return ;;`,
    `    --transport) COMPREPLY=( $(compgen -W "${wordList(["rest", "mcp"])}" -- "$cur") ); return ;;`,
    `    --type) [[ $scope == search ]] && COMPREPLY=( $(compgen -W "${wordList(["mail", "chat", "docs", "drive", "calendar"])}" -- "$cur") ) || COMPREPLY=( $(compgen -W "${wordList(["user", "agent", "service_account", "system"])}" -- "$cur") ); return ;;`,
    `    --direction) COMPREPLY=( $(compgen -W "${wordList(["outbound", "inbound"])}" -- "$cur") ); return ;;`,
    `    --classification) COMPREPLY=( $(compgen -W "${wordList(assistantClassificationValues)}" -- "$cur") ); return ;;`,
    `    --response) COMPREPLY=( $(compgen -W "${wordList(["accepted", "declined", "tentative"])}" -- "$cur") ); return ;;`,
    `    --status) [[ $scope == meet ]] && COMPREPLY=( $(compgen -W "${wordList(["active", "ended"])}" -- "$cur") ) || [[ $scope == admin && $action == tenant-exports ]] && COMPREPLY=( $(compgen -W "${wordList(tenantExportJobStatusValues)}" -- "$cur") ) || [[ $scope == admin ]] && COMPREPLY=( $(compgen -W "${wordList(storageMigrationStatusValues)}" -- "$cur") ) || COMPREPLY=( $(compgen -W "${wordList(["pending", "in_progress", "delivered", "failed", "abandoned"])}" -- "$cur") ); return ;;`,
    `    --target) [[ $scope == admin ]] && COMPREPLY=( $(compgen -W "${wordList(storageMigrationTargetValues)}" -- "$cur") ); return ;;`,
    `    --confirm) [[ $scope == admin && $action == storage-migrations && \${COMP_WORDS[3]} == request ]] && COMPREPLY=( $(compgen -W "LIVE" -- "$cur") ) || [[ $scope == admin && $action == storage-migrations && \${COMP_WORDS[3]} == cutover ]] && COMPREPLY=( $(compgen -W "CUTOVER" -- "$cur") ); return ;;`,
    "    --client-id|--client-secret|--scope|--json|--from) return ;;",
    "  esac",
    "",
    "  if [[ $COMP_CWORD -eq 1 ]]; then",
    `    COMPREPLY=( $(compgen -W "${wordList(topLevelCommands)}" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $COMP_CWORD -eq 2 ]]; then",
    `    [[ $scope == login ]] && COMPREPLY=( $(compgen -W "--client-id --client-secret --scope" -- "$cur") ) && return`,
    bashActionCases("scope"),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == tool && ( $action == call || $action == describe ) && $COMP_CWORD -eq 3 ]]; then",
    '    COMPREPLY=( $(compgen -W "$(_helix_tool_ids)" -- "$cur") )',
    "    return",
    "  fi",
    "",
    "  if [[ $scope == webhook && $COMP_CWORD -eq 3 ]]; then",
    bashWebhookActionCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == admin && $COMP_CWORD -eq 3 ]]; then",
    bashAdminActionCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == mcp && $action == resources && $COMP_CWORD -eq 3 ]]; then",
    `    COMPREPLY=( $(compgen -W "${wordList(["list", "read"])}" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $scope == tier && $action == set && $COMP_CWORD -eq 3 ]]; then",
    `    COMPREPLY=( $(compgen -W "${wordList(securityTierValues)}" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $scope == tool && $action == list ]]; then",
    `    COMPREPLY=( $(compgen -W "--source" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $scope == tool && $action == call ]]; then",
    `    COMPREPLY=( $(compgen -W "--transport --json" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $scope == mail ]]; then",
    bashMailFlagCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == chat ]]; then",
    bashActionFlagCases(chatActionFlags),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == drive ]]; then",
    bashDriveFlagCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == docs ]]; then",
    bashDocsFlagCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == calendar ]]; then",
    bashActionFlagCases(calendarActionFlags),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == meet ]]; then",
    bashActionFlagCases(meetActionFlags),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == assistant ]]; then",
    bashActionFlagCases(assistantActionFlags),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == webhook ]]; then",
    bashWebhookFlagCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == search ]]; then",
    `    COMPREPLY=( $(compgen -W "${wordList(searchFlags)}" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $scope == admin ]]; then",
    bashAdminFlagCases(),
    "    return",
    "  fi",
    "",
    "  if [[ $scope == restore ]]; then",
    `    COMPREPLY=( $(compgen -W "--from --encrypted" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    "  if [[ $scope == login || ( $scope == auth && $action == token ) ]]; then",
    `    COMPREPLY=( $(compgen -W "--client-id --client-secret --scope" -- "$cur") )`,
    "    return",
    "  fi",
    "",
    `  case "$scope" in ${jsonScopes.join("|")}) COMPREPLY=( $(compgen -W "--json" -- "$cur") ) ;; esac`,
    "}",
    "",
    "complete -F _helix_completion helix",
    "",
  ].join("\n");
}

function generateZshCompletion(): string {
  return [
    "#compdef helix",
    "# zsh completion for helix",
    "",
    "_helix_tool_ids() {",
    "  local -a tools",
    `  tools=("\${(@f)$(${dynamicToolIdsScript})}")`,
    "  compadd -- $tools",
    "}",
    "",
    "_helix() {",
    "  local -a top source_values transport_values search_type_values admin_user_type_values tier_values auth_flags json_flag",
    "  local -a direction_values webhook_status_values meet_status_values classification_values storage_migration_target_values storage_migration_status_values tenant_export_status_values",
    `  top=(${zshWords(topLevelCommands)})`,
    "  source_values=(api openapi mcp)",
    "  transport_values=(rest mcp)",
    "  search_type_values=(mail chat docs drive calendar)",
    "  admin_user_type_values=(user agent service_account system)",
    "  tier_values=(personal business enterprise sovereign)",
    "  direction_values=(outbound inbound)",
    "  webhook_status_values=(pending in_progress delivered failed abandoned)",
    "  meet_status_values=(active ended)",
    `  storage_migration_target_values=(${storageMigrationTargetValues.join(" ")})`,
    `  storage_migration_status_values=(${storageMigrationStatusValues.join(" ")})`,
    `  tenant_export_status_values=(${tenantExportJobStatusValues.join(" ")})`,
    `  classification_values=(${assistantClassificationValues.join(" ")})`,
    "  auth_flags=(--client-id --client-secret --scope)",
    "  json_flag=(--json)",
    "",
    "  if (( CURRENT == 2 )); then",
    "    compadd -- $top",
    "    return",
    "  fi",
    "",
    "  if (( CURRENT == 3 )); then",
    "    if [[ ${words[2]} == login ]]; then",
    "      compadd -- $auth_flags",
    "      return",
    "    fi",
    "    case ${words[2]} in",
    zshActionCases(),
    "    esac",
    "    return",
    "  fi",
    "",
    "  case ${words[2]} in",
    "    tool)",
    "      case ${words[3]} in",
    "        list)",
    "          if [[ ${words[CURRENT-1]} == --source ]]; then compadd -- $source_values; else compadd -- --source; fi",
    "          ;;",
    "        call)",
    "          if (( CURRENT == 4 )); then",
    "            _helix_tool_ids",
    "          elif [[ ${words[CURRENT-1]} == --transport ]]; then",
    "            compadd -- $transport_values",
    "          else",
    "            compadd -- --transport --json",
    "          fi",
    "          ;;",
    "        describe)",
    "          if (( CURRENT == 4 )); then _helix_tool_ids; fi",
    "          ;;",
    "      esac",
    "      ;;",
    "    login)",
    "      compadd -- $auth_flags",
    "      ;;",
    "    auth)",
    "      if [[ ${words[3]} == token ]]; then compadd -- $auth_flags; fi",
    "      ;;",
    "    mail)",
    zshMailFlagCases(),
    "      ;;",
    "    chat)",
    zshActionFlagCases(chatActionFlags),
    "      ;;",
    "    drive)",
    zshDriveFlagCases(),
    "      ;;",
    "    docs)",
    zshDocsFlagCases(),
    "      ;;",
    "    calendar)",
    zshActionFlagCases(calendarActionFlags),
    "      ;;",
    "    meet)",
    "      if [[ ${words[CURRENT-1]} == --status ]]; then",
    "        compadd -- $meet_status_values",
    "      else",
    zshActionFlagCases(meetActionFlags),
    "      fi",
    "      ;;",
    "    assistant)",
    "      if [[ ${words[CURRENT-1]} == --classification ]]; then",
    "        compadd -- $classification_values",
    "      else",
    zshActionFlagCases(assistantActionFlags),
    "      fi",
    "      ;;",
    "    webhook)",
    "      if (( CURRENT == 4 )); then",
    "        case ${words[3]} in",
    zshWebhookActionCases(),
    "        esac",
    "      elif [[ ${words[CURRENT-1]} == --direction ]]; then",
    "        compadd -- $direction_values",
    "      elif [[ ${words[CURRENT-1]} == --status && ${words[3]} == tenant-exports ]]; then",
    "        compadd -- $tenant_export_status_values",
    "      elif [[ ${words[CURRENT-1]} == --status ]]; then",
    "        compadd -- $webhook_status_values",
    "      else",
    zshWebhookFlagCases(),
    "      fi",
    "      ;;",
    "    search)",
    "      if [[ ${words[CURRENT-1]} == --type ]]; then",
    "        compadd -- $search_type_values",
    "      else",
    `        compadd -- ${zshWords(searchFlags)}`,
    "      fi",
    "      ;;",
    "    admin)",
    "      if (( CURRENT == 4 )); then",
    "        case ${words[3]} in",
    zshAdminActionCases(),
    "        esac",
    "      elif [[ ${words[CURRENT-1]} == --type ]]; then",
    "        compadd -- $admin_user_type_values",
    "      elif [[ ${words[CURRENT-1]} == --target ]]; then",
    "        compadd -- $storage_migration_target_values",
    "      elif [[ ${words[CURRENT-1]} == --status ]]; then",
    "        compadd -- $storage_migration_status_values",
    "      elif [[ ${words[CURRENT-1]} == --confirm && ${words[3]} == storage-migrations && ${words[4]} == request ]]; then",
    "        compadd -- LIVE",
    "      elif [[ ${words[CURRENT-1]} == --confirm && ${words[3]} == storage-migrations && ${words[4]} == cutover ]]; then",
    "        compadd -- CUTOVER",
    "      else",
    zshAdminFlagCases(),
    "      fi",
    "      ;;",
    "    mcp)",
    "      if [[ ${words[3]} == resources && CURRENT == 4 ]]; then compadd -- list read; fi",
    "      ;;",
    "    restore)",
    "      compadd -- --from --encrypted",
    "      ;;",
    "    tier)",
    "      if [[ ${words[3]} == set ]]; then compadd -- $tier_values; fi",
    "      ;;",
    `    ${jsonScopes.join("|")})`,
    "      compadd -- $json_flag",
    "      ;;",
    "  esac",
    "}",
    "",
    '_helix "$@"',
    "",
  ].join("\n");
}

function generateFishCompletion(): string {
  const lines = [
    "# fish completion for helix",
    "function __helix_tool_ids",
    `  ${dynamicToolIdsScript}`,
    "end",
    "",
    "complete -c helix -f",
    `complete -c helix -n "__fish_use_subcommand" -a "${wordList(topLevelCommands)}"`,
  ];

  for (const [scope, actions] of Object.entries(commandActions)) {
    lines.push(
      `complete -c helix -n "__fish_seen_subcommand_from ${scope}; and not __fish_seen_subcommand_from ${actions.join(" ")}" -a "${wordList(actions)}"`,
    );
  }

  lines.push(
    'complete -c helix -n "__fish_seen_subcommand_from tool; and __fish_seen_subcommand_from call describe" -a "(__helix_tool_ids)"',
    'complete -c helix -n "__fish_seen_subcommand_from tool; and __fish_seen_subcommand_from list" -l source -x -a "api openapi mcp"',
    'complete -c helix -n "__fish_seen_subcommand_from tool; and __fish_seen_subcommand_from call" -l transport -x -a "rest mcp"',
    'complete -c helix -n "__fish_seen_subcommand_from tool; and __fish_seen_subcommand_from call" -l json -x',
    'complete -c helix -n "__fish_seen_subcommand_from mcp; and __fish_seen_subcommand_from resources; and not __fish_seen_subcommand_from list read" -a "list read"',
    'complete -c helix -n "__fish_seen_subcommand_from login; or __fish_seen_subcommand_from token" -l client-id -x',
    'complete -c helix -n "__fish_seen_subcommand_from login; or __fish_seen_subcommand_from token" -l client-secret -x',
    'complete -c helix -n "__fish_seen_subcommand_from login; or __fish_seen_subcommand_from token" -l scope -x',
    'complete -c helix -n "__fish_seen_subcommand_from restore" -l from -x',
    'complete -c helix -n "__fish_seen_subcommand_from restore" -l encrypted',
    ...searchFlags.map(
      (flag) =>
        `complete -c helix -n "__fish_seen_subcommand_from search" -l ${flag.slice(2)} -x${flag === "--type" ? ' -a "mail chat docs drive calendar"' : ""}`,
    ),
    ...fishMailFlagCompletions(),
    ...fishActionFlagCompletions("chat", chatActionFlags),
    ...fishDriveFlagCompletions(),
    ...fishDocsFlagCompletions(),
    ...fishActionFlagCompletions("calendar", calendarActionFlags),
    ...fishActionFlagCompletions("meet", meetActionFlags),
    ...fishAssistantFlagCompletions(),
    ...fishWebhookActionCompletions(),
    ...fishWebhookFlagCompletions(),
    ...fishAdminActionCompletions(),
    ...fishAdminFlagCompletions(),
    `complete -c helix -n "__fish_seen_subcommand_from tier; and __fish_seen_subcommand_from set" -a "${wordList(securityTierValues)}"`,
    `complete -c helix -n "__fish_seen_subcommand_from ${jsonScopes.join(" ")}" -l json -x`,
    "",
  );

  return lines.join("\n");
}

function bashActionCases(scopeVariable: string): string {
  return Object.entries(commandActions)
    .map(
      ([scope, actions]) =>
        `    [[ $${scopeVariable} == ${scope} ]] && COMPREPLY=( $(compgen -W "${wordList(actions)}" -- "$cur") )`,
    )
    .join("\n");
}

function zshActionCases(): string {
  return Object.entries(commandActions)
    .map(([scope, actions]) => `    ${scope}) compadd -- ${zshWords(actions)} ;;`)
    .join("\n");
}

function bashWebhookActionCases(): string {
  return Object.entries(webhookFamilyActions)
    .map(
      ([family, actions]) =>
        `    [[ $action == ${family} ]] && COMPREPLY=( $(compgen -W "${wordList(actions)}" -- "$cur") )`,
    )
    .join("\n");
}

function bashAdminActionCases(): string {
  return Object.entries(adminFamilyActions)
    .map(
      ([family, actions]) =>
        `    [[ $action == ${family} ]] && COMPREPLY=( $(compgen -W "${wordList(actions)}" -- "$cur") )`,
    )
    .join("\n");
}

function bashWebhookFlagCases(): string {
  return Object.entries(webhookActionFlags)
    .map(([key, flags]) => {
      const [family, action] = splitWebhookActionKey(key);
      return `    [[ $action == ${family} && \${COMP_WORDS[3]} == ${action} ]] && COMPREPLY=( $(compgen -W "${wordList(flags)}" -- "$cur") )`;
    })
    .join("\n");
}

function bashAdminFlagCases(): string {
  return Object.entries(adminActionFlags)
    .map(([key, flags]) => {
      const [family, action] = splitActionKey(key, "admin");
      return `    [[ $action == ${family} && \${COMP_WORDS[3]} == ${action} ]] && COMPREPLY=( $(compgen -W "${wordList(flags)}" -- "$cur") )`;
    })
    .join("\n");
}

function zshWebhookActionCases(): string {
  return Object.entries(webhookFamilyActions)
    .map(([family, actions]) => `          ${family}) compadd -- ${zshWords(actions)} ;;`)
    .join("\n");
}

function zshAdminActionCases(): string {
  return Object.entries(adminFamilyActions)
    .map(([family, actions]) => `          ${family}) compadd -- ${zshWords(actions)} ;;`)
    .join("\n");
}

function zshWebhookFlagCases(): string {
  return Object.entries(webhookActionFlags)
    .map(([key, flags]) => {
      const [family, action] = splitWebhookActionKey(key);
      return `        if [[ \${words[3]} == ${family} && \${words[4]} == ${action} ]]; then compadd -- ${zshWords(flags)}; fi`;
    })
    .join("\n");
}

function zshAdminFlagCases(): string {
  return Object.entries(adminActionFlags)
    .map(([key, flags]) => {
      const [family, action] = splitActionKey(key, "admin");
      return `        if [[ \${words[3]} == ${family} && \${words[4]} == ${action} ]]; then compadd -- ${zshWords(flags)}; fi`;
    })
    .join("\n");
}

function bashMailFlagCases(): string {
  return bashActionFlagCases(mailActionFlags);
}

function bashDriveFlagCases(): string {
  return bashActionFlagCases(driveActionFlags);
}

function bashDocsFlagCases(): string {
  return bashActionFlagCases(docsActionFlags);
}

function bashActionFlagCases(actionFlags: Record<string, readonly string[]>): string {
  return Object.entries(actionFlags)
    .map(
      ([action, flags]) =>
        `    [[ $action == ${action} ]] && COMPREPLY=( $(compgen -W "${wordList(flags)}" -- "$cur") )`,
    )
    .join("\n");
}

function zshMailFlagCases(): string {
  return zshActionFlagCases(mailActionFlags);
}

function zshDriveFlagCases(): string {
  return zshActionFlagCases(driveActionFlags);
}

function zshDocsFlagCases(): string {
  return zshActionFlagCases(docsActionFlags);
}

function zshActionFlagCases(actionFlags: Record<string, readonly string[]>): string {
  return Object.entries(actionFlags)
    .map(
      ([action, flags]) =>
        `      if [[ \${words[3]} == ${action} ]]; then compadd -- ${zshWords(flags)}; fi`,
    )
    .join("\n");
}

function fishMailFlagCompletions(): string[] {
  return fishActionFlagCompletions("mail", mailActionFlags);
}

function fishDriveFlagCompletions(): string[] {
  return fishActionFlagCompletions("drive", driveActionFlags);
}

function fishDocsFlagCompletions(): string[] {
  return fishActionFlagCompletions("docs", docsActionFlags);
}

function fishWebhookActionCompletions(): string[] {
  return Object.entries(webhookFamilyActions).map(
    ([family, actions]) =>
      `complete -c helix -n "__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from ${family}; and not __fish_seen_subcommand_from ${actions.join(" ")}" -a "${wordList(actions)}"`,
  );
}

function fishWebhookFlagCompletions(): string[] {
  return Object.entries(webhookActionFlags).flatMap(([key, flags]) => {
    const [family, action] = splitWebhookActionKey(key);
    return flags.map((flag) => {
      const values = webhookFlagValues(flag);
      return `complete -c helix -n "__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from ${family}; and __fish_seen_subcommand_from ${action}" -l ${flag.slice(2)} -x${values}`;
    });
  });
}

function fishAdminActionCompletions(): string[] {
  return Object.entries(adminFamilyActions).map(
    ([family, actions]) =>
      `complete -c helix -n "__fish_seen_subcommand_from admin; and __fish_seen_subcommand_from ${family}; and not __fish_seen_subcommand_from ${actions.join(" ")}" -a "${wordList(actions)}"`,
  );
}

function fishAdminFlagCompletions(): string[] {
  return Object.entries(adminActionFlags).flatMap(([key, flags]) => {
    const [family, action] = splitActionKey(key, "admin");
    return flags.map((flag) => {
      const values = adminFlagValues(flag);
      return `complete -c helix -n "__fish_seen_subcommand_from admin; and __fish_seen_subcommand_from ${family}; and __fish_seen_subcommand_from ${action}" -l ${flag.slice(2)} -x${values}`;
    });
  });
}

function fishAssistantFlagCompletions(): string[] {
  return Object.entries(assistantActionFlags).flatMap(([action, flags]) =>
    flags.map((flag) => {
      const values =
        flag === "--classification" ? ` -a "${wordList(assistantClassificationValues)}"` : "";
      return `complete -c helix -n "__fish_seen_subcommand_from assistant; and __fish_seen_subcommand_from ${action}" -l ${flag.slice(2)} -x${values}`;
    }),
  );
}

function fishActionFlagCompletions(
  scope: string,
  actionFlags: Record<string, readonly string[]>,
): string[] {
  return Object.entries(actionFlags).flatMap(([action, flags]) =>
    flags.map(
      (flag) =>
        `complete -c helix -n "__fish_seen_subcommand_from ${scope}; and __fish_seen_subcommand_from ${action}" -l ${flag.slice(2)} -x`,
    ),
  );
}

function webhookFlagValues(flag: string): string {
  if (flag === "--direction") {
    return ' -a "outbound inbound"';
  }
  if (flag === "--status") {
    return ' -a "pending in_progress delivered failed abandoned"';
  }
  return "";
}

function adminFlagValues(flag: string): string {
  if (flag === "--type") {
    return ' -a "user agent service_account system"';
  }
  if (flag === "--target") {
    return ' -a "byo helix-default"';
  }
  if (flag === "--status") {
    return ' -a "queued running succeeded succeeded_with_errors failed dry_run"';
  }
  if (flag === "--confirm") {
    return ' -a "LIVE CUTOVER"';
  }
  return "";
}

function splitWebhookActionKey(key: string): readonly [string, string] {
  return splitActionKey(key, "webhook");
}

function splitActionKey(key: string, label: string): readonly [string, string] {
  const separator = key.indexOf(":");
  if (separator < 1 || separator === key.length - 1) {
    throw new Error(`Invalid ${label} completion key: ${key}`);
  }
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function wordList(words: readonly string[]): string {
  return words.join(" ");
}

function zshWords(words: readonly string[]): string {
  return words.map((word) => shellQuote(word)).join(" ");
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}
