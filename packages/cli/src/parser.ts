export type HelixCommand =
  | { readonly kind: "tool-list"; readonly source?: ToolListSource }
  | {
      readonly kind: "tool-call";
      readonly toolId: string;
      readonly json: JsonArgument;
      readonly transport?: ToolCallTransport;
    }
  | { readonly kind: "tool-describe"; readonly toolId: string }
  | {
      readonly kind: "auth-token";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scope?: string;
      readonly printExport?: boolean;
    }
  | { readonly kind: "logout" }
  | { readonly kind: "install-list" }
  | {
      readonly kind: "install-plugin";
      readonly pluginId: string;
      readonly version?: string;
      readonly json: JsonArgument;
    }
  | {
      readonly kind: "plugin-lifecycle";
      readonly action: PluginLifecycleAction;
      readonly pluginId: string;
      readonly json: JsonArgument;
    }
  | {
      readonly kind: "admin-users-list";
      readonly query?: string;
      readonly type?: AdminUserType;
      readonly includeDisabled?: boolean;
      readonly limit?: number;
      readonly cursor?: string;
    }
  | {
      readonly kind: "admin-audit-list";
      readonly actorId?: string;
      readonly objectId?: string;
      readonly objectType?: string;
      readonly verb?: string;
      readonly limit?: number;
      readonly cursor?: string;
    }
  | { readonly kind: "admin-storage-test" }
  | {
      readonly kind: "admin-storage-migration-list";
      readonly target?: TenantStorageMigrationTarget;
      readonly status?: TenantStorageMigrationStatus;
      readonly limit?: number;
      readonly cursor?: string;
    }
  | {
      readonly kind: "admin-storage-migration-request";
      readonly target: TenantStorageMigrationTarget;
      readonly dryRun: boolean;
      readonly sourceStorage?: Record<string, unknown>;
      readonly targetStorage?: Record<string, unknown>;
    }
  | { readonly kind: "admin-storage-migration-get"; readonly migrationId: string }
  | { readonly kind: "admin-storage-migration-cutover"; readonly migrationId: string }
  | {
      readonly kind: "tenant-export-queue";
      readonly slug: string;
      readonly includeObjectBytes: boolean;
      readonly presignedUrlExpiresSeconds?: number;
    }
  | {
      readonly kind: "tenant-export-list";
      readonly slug: string;
      readonly status?: TenantExportJobStatus;
      readonly limit?: number;
      readonly cursor?: string;
    }
  | { readonly kind: "tenant-export-status"; readonly slug: string; readonly jobId: string }
  | {
      readonly kind: "tenant-export-download";
      readonly slug: string;
      readonly jobId: string;
      readonly output: string;
      readonly force: boolean;
    }
  | {
      readonly kind: "tenant-import-dry-run";
      readonly slug: string;
      readonly archive: string;
    }
  | { readonly kind: "backup-create" }
  | { readonly kind: "restore-from"; readonly backupId: string; readonly encrypted?: boolean }
  | { readonly kind: "reindex-all" }
  | { readonly kind: "action-status"; readonly actionId: string }
  | { readonly kind: "action-approve"; readonly actionId: string }
  | { readonly kind: "action-cancel"; readonly actionId: string }
  | { readonly kind: "tier-set"; readonly tier: SecurityTier }
  | { readonly kind: "openapi-get" }
  | { readonly kind: "asyncapi-get" }
  | { readonly kind: "mcp-resource-list" }
  | { readonly kind: "mcp-resource-read"; readonly uri: string }
  | { readonly kind: "mcp-serve" }
  | { readonly kind: "completion"; readonly shell: CompletionShell }
  | { readonly kind: "help" };

export type ToolListSource = "api" | "openapi" | "mcp";
export type ToolCallTransport = "rest" | "mcp";
export type CompletionShell = "bash" | "zsh" | "fish";
export type SearchType = "mail" | "chat" | "docs" | "drive" | "calendar";
export type AdminUserType = "user" | "agent" | "service_account" | "system";
export type SecurityTier = "personal" | "business" | "enterprise" | "sovereign";
export type PluginLifecycleAction = "enable" | "disable" | "uninstall";
export type TenantStorageMigrationTarget = "byo" | "helix-default";
export type TenantStorageMigrationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "succeeded_with_errors"
  | "failed"
  | "dry_run";
export type TenantExportJobStatus = "queued" | "running" | "succeeded" | "failed";

export type JsonArgument =
  | { readonly source: "empty" }
  | { readonly source: "inline"; readonly value: string }
  | { readonly source: "stdin" };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(args: readonly string[]): HelixCommand {
  const [scope, action, subject, ...rest] = args;

  if (scope === undefined || scope === "-h" || scope === "--help") {
    return { kind: "help" };
  }

  if (scope === "tool" && action === "list") {
    return parseToolListCommand(
      [subject, ...rest].filter((value): value is string => value !== undefined),
    );
  }

  if (scope === "tool" && action === "call") {
    if (subject === undefined || subject.startsWith("-")) {
      throw new CliUsageError(
        "Usage: helix tool call <id> [--transport <rest|mcp>] [--json [JSON]]",
      );
    }
    return parseToolCallCommand(subject, rest);
  }

  if (scope === "tool" && action === "describe") {
    if (subject === undefined || subject.startsWith("-") || rest.length > 0) {
      throw new CliUsageError("Usage: helix tool describe <id>");
    }
    return { kind: "tool-describe", toolId: subject };
  }

  if (scope === "mail") {
    return parseMailCommand(action, subject, rest);
  }

  if (scope === "chat") {
    return parseChatCommand(action, subject, rest);
  }

  if (scope === "drive") {
    return parseDriveCommand(action, subject, rest);
  }

  if (scope === "docs") {
    return parseDocsCommand(action, subject, rest);
  }

  if (scope === "calendar") {
    return parseCalendarCommand(action, subject, rest);
  }

  if (scope === "meet") {
    return parseMeetCommand(action, subject, rest);
  }

  if (scope === "assistant") {
    return parseAssistantCommand(action, subject, rest);
  }

  if (scope === "webhook") {
    return parseWebhookCommand(action, subject, rest);
  }

  if (scope === "search") {
    return parseSearchCommand([action, subject, ...rest].filter(isDefined));
  }

  if (scope === "admin") {
    return parseAdminCommand(action, subject, rest);
  }

  if (scope === "backup") {
    return parseBackupCommand(action, subject, rest);
  }

  if (scope === "restore") {
    return parseRestoreCommand(
      [action, subject, ...rest].filter((value): value is string => value !== undefined),
    );
  }

  if (scope === "reindex") {
    return parseReindexCommand(
      [action, subject, ...rest].filter((value): value is string => value !== undefined),
    );
  }

  if (scope === "action") {
    return parseActionCommand(action, subject, rest);
  }

  if (scope === "tier") {
    return parseTierCommand(action, subject, rest);
  }

  if (scope === "auth" && action === "token") {
    return parseAuthTokenCommand(
      [subject, ...rest].filter((value): value is string => value !== undefined),
      "helix auth token",
    );
  }

  if (scope === "login") {
    return parseAuthTokenCommand(
      [action, subject, ...rest].filter((value): value is string => value !== undefined),
      "helix login",
      true,
    );
  }

  if (scope === "logout") {
    if (action !== undefined || subject !== undefined || rest.length > 0) {
      throw new CliUsageError("Usage: helix logout");
    }
    return { kind: "logout" };
  }

  if (scope === "install" && action === "list" && subject === undefined) {
    return { kind: "install-list" };
  }

  if (scope === "install" && isPluginLifecycleAction(action)) {
    return parsePluginLifecycleCommand(action, subject, rest, `helix install ${action}`);
  }

  if (scope === "install" && action === "plugin") {
    if (subject === undefined || subject.startsWith("-")) {
      throw new CliUsageError("Usage: helix install plugin <id> [--json [JSON]]");
    }
    return {
      ...parsePluginSpecifier(subject),
      kind: "install-plugin",
      json: parseJsonArgument(rest),
    };
  }

  if (scope === "plugin" && isPluginLifecycleAction(action)) {
    return parsePluginLifecycleCommand(action, subject, rest, `helix plugin ${action}`);
  }

  if (scope === "plugin" && action === "install") {
    if (subject === undefined || subject.startsWith("-")) {
      throw new CliUsageError("Usage: helix plugin install <id>[@<version>] [--json [JSON]]");
    }
    return {
      ...parsePluginSpecifier(subject),
      kind: "install-plugin",
      json: parseJsonArgument(rest),
    };
  }

  if (scope === "openapi" && action === "get" && subject === undefined) {
    return { kind: "openapi-get" };
  }

  if (scope === "asyncapi" && action === "get" && subject === undefined) {
    return { kind: "asyncapi-get" };
  }

  if (scope === "mcp") {
    return parseMcpCommand(action, subject, rest);
  }

  if (scope === "completion") {
    if (
      (action === "bash" || action === "zsh" || action === "fish") &&
      subject === undefined &&
      rest.length === 0
    ) {
      return { kind: "completion", shell: action };
    }
    throw new CliUsageError("Usage: helix completion <bash|zsh|fish>");
  }

  throw new CliUsageError(`Unknown command: ${args.join(" ")}`);
}

function parsePluginLifecycleCommand(
  action: PluginLifecycleAction,
  pluginId: string | undefined,
  args: readonly string[],
  usagePrefix: string,
): HelixCommand {
  if (pluginId === undefined || pluginId.startsWith("-")) {
    throw new CliUsageError(`Usage: ${usagePrefix} <id> [--json [JSON]]`);
  }
  return {
    kind: "plugin-lifecycle",
    action,
    pluginId,
    json: parseJsonArgument(args),
  };
}

function isPluginLifecycleAction(value: string | undefined): value is PluginLifecycleAction {
  return value === "enable" || value === "disable" || value === "uninstall";
}

function parseToolListCommand(args: readonly string[]): HelixCommand {
  if (args.length === 0) {
    return { kind: "tool-list" };
  }

  const flags = parseFlags(args, new Set(["--source"]));
  const source = flags.get("--source");
  if (source !== "api" && source !== "openapi" && source !== "mcp") {
    throw new CliUsageError("Usage: helix tool list [--source <api|openapi|mcp>]");
  }
  return { kind: "tool-list", source };
}

function parseToolCallCommand(toolId: string, args: readonly string[]): HelixCommand {
  let json: JsonArgument | undefined;
  let transport: ToolCallTransport | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--transport") {
      const value = args[index + 1];
      if (value !== "rest" && value !== "mcp") {
        throw new CliUsageError(
          "Usage: helix tool call <id> [--transport <rest|mcp>] [--json [JSON]]",
        );
      }
      transport = value;
      index += 1;
      continue;
    }

    if (flag === "--json") {
      if (json !== undefined) {
        throw new CliUsageError(
          "Usage: helix tool call <id> [--transport <rest|mcp>] [--json [JSON]]",
        );
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        json = { source: "stdin" };
        continue;
      }
      json = { source: "inline", value };
      index += 1;
      continue;
    }

    throw new CliUsageError("Usage: helix tool call <id> [--transport <rest|mcp>] [--json [JSON]]");
  }

  return {
    kind: "tool-call",
    toolId,
    json: json ?? { source: "empty" },
    ...(transport === undefined ? {} : { transport }),
  };
}

function parseMcpCommand(
  action: string | undefined,
  subject: string | undefined,
  args: readonly string[],
): HelixCommand {
  if (action === "serve" && subject === undefined && args.length === 0) {
    return { kind: "mcp-serve" };
  }
  if (action === "resources" && subject === "list" && args.length === 0) {
    return { kind: "mcp-resource-list" };
  }
  if (action === "resources" && subject === "read") {
    const [uri, ...rest] = args;
    if (uri !== undefined && !uri.startsWith("-") && rest.length === 0) {
      return { kind: "mcp-resource-read", uri };
    }
  }
  throw new CliUsageError(
    "Usage: helix mcp serve | helix mcp resources list | helix mcp resources read <uri>",
  );
}

function parsePluginSpecifier(specifier: string): {
  readonly pluginId: string;
  readonly version?: string;
} {
  const versionSeparator = specifier.lastIndexOf("@");
  if (versionSeparator > 0 && versionSeparator < specifier.length - 1) {
    return {
      pluginId: specifier.slice(0, versionSeparator),
      version: specifier.slice(versionSeparator + 1),
    };
  }
  return { pluginId: specifier };
}

function parseMailCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  switch (action) {
    case "send":
      return {
        kind: "tool-call",
        toolId: "mail.send",
        json: parseMailOptions(jsonArgs, mailSendOptions, "helix mail send"),
      };
    case "reply":
      return {
        kind: "tool-call",
        toolId: "mail.reply",
        json: parseMailOptions(jsonArgs, mailReplyOptions, "helix mail reply"),
      };
    case "list":
      return {
        kind: "tool-call",
        toolId: "mail.list",
        json: parseMailOptions(jsonArgs, mailListOptions, "helix mail list"),
      };
    case "search":
      return {
        kind: "tool-call",
        toolId: "mail.search",
        json: parseMailOptions(jsonArgs, mailSearchOptions, "helix mail search"),
      };
    case "label":
      return {
        kind: "tool-call",
        toolId: "mail.label.apply",
        json: parseTypedOptions(jsonArgs, mailLabelApplyOptions, mailLabelApplyUsage),
      };
    case "archive":
      return {
        kind: "tool-call",
        toolId: "mail.archive",
        json: parseTypedOptions(jsonArgs, mailThreadIdOptions, mailArchiveUsage),
      };
    case "delete":
      return {
        kind: "tool-call",
        toolId: "mail.delete",
        json: parseTypedOptions(jsonArgs, mailThreadIdOptions, mailDeleteUsage),
      };
    case "snooze":
      return {
        kind: "tool-call",
        toolId: "mail.snooze",
        json: parseTypedOptions(jsonArgs, mailSnoozeOptions, mailSnoozeUsage),
      };
    case "read":
      return {
        kind: "tool-call",
        toolId: "mail.read.set",
        json: parseTypedOptions(jsonArgs, mailReadSetOptions, mailReadSetUsage),
      };
    case "star":
      return {
        kind: "tool-call",
        toolId: "mail.star.set",
        json: parseMailBooleanOptions(
          jsonArgs,
          new Map([["--thread-id", "threadId"]]),
          mailStarSetBooleans,
          mailStarSetUsage,
        ),
      };
    case "thread-get":
    case "thread":
      return {
        kind: "tool-call",
        toolId: "mail.thread.get",
        json: parseTypedOptions(jsonArgs, mailThreadIdOptions, mailThreadGetUsage),
      };
    case "filter-create":
      return {
        kind: "tool-call",
        toolId: "mail.filter.create",
        json: parseMailFilterOptions(jsonArgs, mailFilterCreateSpec, mailFilterCreateUsage),
      };
    case "filter-update":
      return {
        kind: "tool-call",
        toolId: "mail.filter.update",
        json: parseMailFilterOptions(jsonArgs, mailFilterUpdateSpec, mailFilterUpdateUsage),
      };
    case "filter-delete":
      return {
        kind: "tool-call",
        toolId: "mail.filter.delete",
        json: parseTypedOptions(jsonArgs, mailFilterDeleteOptions, mailFilterDeleteUsage),
      };
    case "vacation-get":
      return {
        kind: "tool-call",
        toolId: "mail.vacation.get",
        json: parseJsonArgument(jsonArgs),
      };
    case "vacation-set":
      return {
        kind: "tool-call",
        toolId: "mail.vacation.set",
        json: parseMailBooleanOptions(
          jsonArgs,
          new Map([
            ["--subject", "subject"],
            ["--body", "body"],
            ["--start", "startsAt"],
            ["--end", "endsAt"],
          ]),
          mailFilterEnabledBooleans,
          mailVacationSetUsage,
        ),
      };
    default:
      throw new CliUsageError(mailUsageSummary);
  }
}

const mailUsageSummary =
  "Usage: helix mail <send|reply|list|search|label|archive|delete|snooze|read|star|thread-get|filter-create|filter-update|filter-delete|vacation-get|vacation-set> [--json [JSON]]";
const mailLabelApplyUsage =
  "Usage: helix mail label [--thread-id <id>] [--add <label>] [--remove <label>] [--json [JSON]]";
const mailArchiveUsage = "Usage: helix mail archive [--thread-id <id>] [--json [JSON]]";
const mailDeleteUsage = "Usage: helix mail delete [--thread-id <id>] [--json [JSON]]";
const mailThreadGetUsage = "Usage: helix mail thread-get [--thread-id <id>] [--json [JSON]]";
const mailSnoozeUsage =
  "Usage: helix mail snooze [--thread-id <id>] [--until <iso>] [--json [JSON]]";
const mailReadSetUsage = "Usage: helix mail read [--thread-id <id>] [--unread] [--json [JSON]]";
const mailStarSetUsage =
  "Usage: helix mail star [--thread-id <id>] [--starred] [--unstarred] [--json [JSON]]";
const mailFilterCreateUsage =
  "Usage: helix mail filter-create [--name <name>] [--priority <number>] [--enabled] [--disabled] [--criteria <json-object>] [--actions <json-object>] [--json [JSON]]";
const mailFilterUpdateUsage =
  "Usage: helix mail filter-update [--id <id>] [--name <name>] [--priority <number>] [--enabled] [--disabled] [--criteria <json-object>] [--actions <json-object>] [--json [JSON]]";
const mailFilterDeleteUsage = "Usage: helix mail filter-delete [--id <id>] [--json [JSON]]";
const mailVacationSetUsage =
  "Usage: helix mail vacation-set [--enabled] [--disabled] [--subject <text>] [--body <text>] [--start <iso>] [--end <iso>] [--json [JSON]]";

const mailThreadIdOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--thread-id", "threadId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const mailLabelApplyOptions = {
  arrays: new Map([
    ["--add", "add"],
    ["--remove", "remove"],
  ]),
  strings: new Map([["--thread-id", "threadId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const mailSnoozeOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--thread-id", "threadId"],
    ["--until", "until"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const mailReadSetOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--thread-id", "threadId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map([["--unread", "unread"]]),
} as const;

const mailStarSetBooleans = new Map([
  ["--starred", { field: "starred", value: true }],
  ["--unstarred", { field: "starred", value: false }],
]);

const mailFilterDeleteOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--id", "id"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const mailFilterEnabledBooleans = new Map([
  ["--enabled", { field: "enabled", value: true }],
  ["--disabled", { field: "enabled", value: false }],
]);

type MailFilterSpec = {
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
  readonly jsonObjects: ReadonlyMap<string, string>;
};

const mailFilterCreateSpec: MailFilterSpec = {
  strings: new Map([["--name", "name"]]),
  numbers: new Map([["--priority", "priority"]]),
  jsonObjects: new Map([
    ["--criteria", "criteria"],
    ["--actions", "actions"],
  ]),
};

const mailFilterUpdateSpec: MailFilterSpec = {
  strings: new Map([
    ["--id", "id"],
    ["--name", "name"],
  ]),
  numbers: new Map([["--priority", "priority"]]),
  jsonObjects: new Map([
    ["--criteria", "criteria"],
    ["--actions", "actions"],
  ]),
};

function parseMailFilterOptions(
  args: readonly string[],
  spec: MailFilterSpec,
  usageMessage: string,
): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }
  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const enabledOption = mailFilterEnabledBooleans.get(flag);
    if (enabledOption !== undefined) {
      input[enabledOption.field] = enabledOption.value;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      input[stringField] = value;
      index += 1;
      continue;
    }

    const numberField = spec.numbers.get(flag);
    if (numberField !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new CliUsageError(usageMessage);
      }
      input[numberField] = parsed;
      index += 1;
      continue;
    }

    const jsonObjectField = spec.jsonObjects.get(flag);
    if (jsonObjectField !== undefined) {
      input[jsonObjectField] = parseJsonObjectFlag(value, usageMessage);
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }

  return { source: "inline", value: JSON.stringify(input) };
}

const mailSendOptions = {
  arrays: new Set(["--to", "--cc", "--bcc"]),
  strings: new Map([
    ["--from", "from"],
    ["--subject", "subject"],
    ["--body", "body"],
    ["--html", "html"],
  ]),
  numbers: new Map<string, string>(),
} as const;

const mailReplyOptions = {
  arrays: new Set(["--cc", "--bcc"]),
  strings: new Map([
    ["--thread-id", "threadId"],
    ["--message-id", "messageId"],
    ["--body", "body"],
    ["--html", "html"],
  ]),
  numbers: new Map<string, string>(),
} as const;

const mailListOptions = {
  arrays: new Set(["--label"]),
  strings: new Map([
    ["--mailbox", "mailbox"],
    ["--cursor", "cursor"],
  ]),
  numbers: new Map([["--limit", "limit"]]),
} as const;

const mailSearchOptions = {
  arrays: new Set(["--label"]),
  strings: new Map([
    ["--query", "query"],
    ["--mailbox", "mailbox"],
    ["--cursor", "cursor"],
  ]),
  numbers: new Map([["--limit", "limit"]]),
} as const;

type MailOptionSpec = {
  readonly arrays: ReadonlySet<string>;
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
};

function parseMailOptions(
  args: readonly string[],
  spec: MailOptionSpec,
  commandName: string,
): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || value.startsWith("--")) {
      throw new CliUsageError(mailUsage(commandName, spec));
    }

    if (spec.arrays.has(flag)) {
      const field = flag.slice(2).replaceAll("-", "_");
      input[field] = [...readStringArray(input[field]), ...parseCommaSeparatedValues(value)];
      continue;
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      input[stringField] = value;
      continue;
    }

    const numberField = spec.numbers.get(flag);
    if (numberField !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new CliUsageError(mailUsage(commandName, spec));
      }
      input[numberField] = parsed;
      continue;
    }

    throw new CliUsageError(mailUsage(commandName, spec));
  }

  return { source: "inline", value: JSON.stringify(input) };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function parseCommaSeparatedValues(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string, usageMessage: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(usageMessage);
  }
  return parsed;
}

function inlineJson(input: Record<string, unknown>): JsonArgument {
  return { source: "inline", value: JSON.stringify(input) };
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

function mailUsage(commandName: string, spec: MailOptionSpec): string {
  const arrayFlags = [...spec.arrays].map((flag) => `${flag} <value>`);
  const stringFlags = [...spec.strings.keys()].map((flag) => `${flag} <value>`);
  const numberFlags = [...spec.numbers.keys()].map((flag) => `${flag} <number>`);
  return `Usage: ${commandName} [--json [JSON]] [${[...arrayFlags, ...stringFlags, ...numberFlags].join("] [")}]`;
}

type MailBooleanOption = { readonly field: string; readonly value: boolean };

function parseMailBooleanOptions(
  args: readonly string[],
  strings: ReadonlyMap<string, string>,
  booleans: ReadonlyMap<string, MailBooleanOption>,
  usageMessage: string,
): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }
  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const booleanOption = booleans.get(flag);
    if (booleanOption !== undefined) {
      input[booleanOption.field] = booleanOption.value;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const stringField = strings.get(flag);
    if (stringField !== undefined) {
      input[stringField] = value;
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }

  return { source: "inline", value: JSON.stringify(input) };
}

function parseChatCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  if (subject !== undefined && !subject.startsWith("--")) {
    throw new CliUsageError(chatUsage);
  }
  switch (action) {
    case "send":
      return {
        kind: "tool-call",
        toolId: "chat.send",
        json: parseTypedOptions(jsonArgs, chatSendOptions, chatSendUsage),
      };
    case "react":
      return { kind: "tool-call", toolId: "chat.react", json: parseJsonArgument(jsonArgs) };
    case "edit":
      return { kind: "tool-call", toolId: "chat.edit", json: parseJsonArgument(jsonArgs) };
    case "delete":
      return { kind: "tool-call", toolId: "chat.delete", json: parseJsonArgument(jsonArgs) };
    case "create-room":
      return {
        kind: "tool-call",
        toolId: "chat.create_room",
        json: parseTypedOptions(jsonArgs, chatCreateRoomOptions, chatCreateRoomUsage),
      };
    case "invite":
      return { kind: "tool-call", toolId: "chat.invite", json: parseJsonArgument(jsonArgs) };
    case "search":
    case "list":
      return {
        kind: "tool-call",
        toolId: "chat.search",
        json: parseTypedOptions(jsonArgs, chatSearchOptions, chatSearchUsage),
      };
    case "messages":
    case "message-list":
      return {
        kind: "tool-call",
        toolId: "chat.message.list",
        json: parseTypedOptions(jsonArgs, chatMessageListOptions, chatMessageListUsage),
      };
    default:
      throw new CliUsageError(chatUsage);
  }
}

const chatUsage =
  "Usage: helix chat <send|react|edit|delete|create-room|invite|search|messages> [--json [JSON]]";
const chatMessageListUsage =
  "Usage: helix chat messages [--room-id <id>] [--before <iso>] [--limit <number>] [--json [JSON]]";

const chatMessageListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--room-id", "roomId"],
    ["--before", "before"],
  ]),
  numbers: new Map([["--limit", "limit"]]),
  booleans: new Map<string, string>(),
} as const;
const chatSendUsage =
  "Usage: helix chat send [--room-id <id>] [--body <text>] [--text <text>] [--json [JSON]]";
const chatCreateRoomUsage =
  "Usage: helix chat create-room [--name <name>] [--description <text>] [--member <id>] [--private] [--json [JSON]]";
const chatSearchUsage =
  "Usage: helix chat search [--query <text>] [--room-id <id>] [--limit <number>] [--cursor <cursor>] [--json [JSON]]";

const chatSendOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--room-id", "roomId"],
    ["--body", "body"],
    ["--text", "body"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const chatCreateRoomOptions = {
  arrays: new Map([["--member", "memberActorIds"]]),
  strings: new Map([
    ["--name", "subject"],
    ["--subject", "subject"],
    ["--description", "topic"],
    ["--topic", "topic"],
    ["--kind", "kind"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map([["--private", "isPrivate"]]),
  enums: new Map([["--kind", new Set(["chat_room", "chat_dm"])]]),
} as const;

const chatSearchOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--query", "query"],
    ["--room-id", "roomId"],
    ["--cursor", "cursor"],
  ]),
  numbers: new Map([["--limit", "limit"]]),
  booleans: new Map<string, string>(),
} as const;

function parseDriveCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  switch (action) {
    case "upload":
      return {
        kind: "tool-call",
        toolId: "drive.upload",
        json: parseDriveUploadOptions(subject, rest),
      };
    case "finalize":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveUsage);
      }
      return { kind: "tool-call", toolId: "drive.finalize", json: parseJsonArgument(jsonArgs) };
    case "list":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveListUsage);
      }
      return {
        kind: "tool-call",
        toolId: "drive.list",
        json: parseDriveListOptions(jsonArgs),
      };
    case "share":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveUsage);
      }
      return { kind: "tool-call", toolId: "drive.share", json: parseJsonArgument(jsonArgs) };
    case "move":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveUsage);
      }
      return { kind: "tool-call", toolId: "drive.move", json: parseJsonArgument(jsonArgs) };
    case "trash":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveUsage);
      }
      return { kind: "tool-call", toolId: "drive.trash", json: parseJsonArgument(jsonArgs) };
    case "restore":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveUsage);
      }
      return { kind: "tool-call", toolId: "drive.restore", json: parseJsonArgument(jsonArgs) };
    case "delete":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveUsage);
      }
      return { kind: "tool-call", toolId: "drive.delete", json: parseJsonArgument(jsonArgs) };
    case "search":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(driveSearchUsage);
      }
      return {
        kind: "tool-call",
        toolId: "drive.search",
        json: parseDriveSearchOptions(jsonArgs),
      };
    default:
      throw new CliUsageError(driveUsage);
  }
}

const driveUsage =
  "Usage: helix drive <upload|finalize|list|share|move|trash|restore|delete|search> [--json [JSON]]";
const driveUploadUsage =
  "Usage: helix drive upload <path> [--folder <folder-id>] [--name <name>] [--mime-type <type>] [--byte-size <number>] [--sha256 <hex>] [--json [JSON]]";
const driveListUsage =
  "Usage: helix drive list [--folder <folder-id>] [--limit <number>] [--include-trashed] [--json [JSON]]";
const driveSearchUsage =
  "Usage: helix drive search [--query <text>] [--folder <folder-id>] [--limit <number>] [--json [JSON]]";

function parseDriveUploadOptions(path: string | undefined, args: readonly string[]): JsonArgument {
  if (path === undefined) {
    return args.length === 0 ? { source: "empty" } : parseJsonArgument(args);
  }

  if (path === "--json") {
    return parseJsonArgument([path, ...args]);
  }

  if (path.startsWith("--")) {
    throw new CliUsageError(driveUploadUsage);
  }

  const input: Record<string, unknown> = {
    name: basename(path),
    metadata: { localPath: path },
  };
  parseDriveFlags(
    args,
    driveUploadUsage,
    {
      strings: new Map([
        ["--folder", "folderId"],
        ["--name", "name"],
        ["--mime-type", "mimeType"],
        ["--sha256", "sha256"],
      ]),
      numbers: new Map([["--byte-size", "byteSize"]]),
      booleans: new Map<string, string>(),
    },
    input,
  );
  return { source: "inline", value: JSON.stringify(input) };
}

function parseDriveListOptions(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  parseDriveFlags(
    args,
    driveListUsage,
    {
      strings: new Map([["--folder", "folderId"]]),
      numbers: new Map([["--limit", "limit"]]),
      booleans: new Map([["--include-trashed", "includeTrashed"]]),
    },
    input,
  );
  return { source: "inline", value: JSON.stringify(input) };
}

function parseDriveSearchOptions(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  parseDriveFlags(
    args,
    driveSearchUsage,
    {
      strings: new Map([
        ["--query", "query"],
        ["--folder", "folderId"],
      ]),
      numbers: new Map([["--limit", "limit"]]),
      booleans: new Map<string, string>(),
    },
    input,
  );
  return { source: "inline", value: JSON.stringify(input) };
}

type DriveOptionSpec = {
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
  readonly booleans: ReadonlyMap<string, string>;
};

function parseDriveFlags(
  args: readonly string[],
  usageMessage: string,
  spec: DriveOptionSpec,
  input: Record<string, unknown>,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const booleanField = spec.booleans.get(flag);
    if (booleanField !== undefined) {
      input[booleanField] = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      input[stringField] = value;
      index += 1;
      continue;
    }

    const numberField = spec.numbers.get(flag);
    if (numberField !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new CliUsageError(usageMessage);
      }
      input[numberField] = parsed;
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function parseDocsCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  switch (action) {
    case "create":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(docsCreateUsage);
      }
      return { kind: "tool-call", toolId: "docs.create", json: parseDocsCreateOptions(jsonArgs) };
    case "update-title":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(docsUpdateTitleUsage);
      }
      return {
        kind: "tool-call",
        toolId: "docs.update-title",
        json: parseDocsUpdateTitleOptions(jsonArgs),
      };
    case "export":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(docsExportUsage);
      }
      return { kind: "tool-call", toolId: "docs.export", json: parseDocsExportOptions(jsonArgs) };
    case "comment-create":
    case "comment":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(docsCommentCreateUsage);
      }
      return {
        kind: "tool-call",
        toolId: "docs.comment.create",
        json: parseDocsCommentCreateOptions(jsonArgs),
      };
    case "get":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(docsGetUsage);
      }
      return {
        kind: "tool-call",
        toolId: "docs.get",
        json: parseTypedOptions(jsonArgs, docsGetOptions, docsGetUsage),
      };
    case "list":
      if (subject !== undefined && !subject.startsWith("--")) {
        throw new CliUsageError(docsListUsage);
      }
      return {
        kind: "tool-call",
        toolId: "docs.list",
        json: parseTypedOptions(jsonArgs, docsListOptions, docsListUsage),
      };
    default:
      throw new CliUsageError(docsUsage);
  }
}

const docsUsage =
  "Usage: helix docs <create|get|list|update-title|export|comment-create> [--json [JSON]]";
const docsGetUsage = "Usage: helix docs get [--doc-id <id>] [--json [JSON]]";
const docsListUsage = "Usage: helix docs list [--query <text>] [--limit <number>] [--json [JSON]]";

const docsGetOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--doc-id", "docId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const docsListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--query", "query"]]),
  numbers: new Map([["--limit", "limit"]]),
  booleans: new Map<string, string>(),
} as const;
const docsCreateUsage =
  "Usage: helix docs create [--title <text>] [--initial-markdown <markdown>] [--folder <folder-id>] [--metadata <json-object>] [--json [JSON]]";
const docsUpdateTitleUsage =
  "Usage: helix docs update-title [--doc-id <id>] [--title <text>] [--json [JSON]]";
const docsExportUsage =
  "Usage: helix docs export [--doc-id <id>] [--format <markdown|pdf|docx>] [--include-comments] [--filename <name>] [--json [JSON]]";
const docsCommentCreateUsage =
  "Usage: helix docs comment-create [--doc-id <id>] [--body <text>] [--anchor <json-object>] [--metadata <json-object>] [--json [JSON]]";

function parseDocsCreateOptions(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  return parseDocsFlags(args, docsCreateUsage, {
    strings: new Map([
      ["--title", "title"],
      ["--initial-markdown", "initialMarkdown"],
      ["--folder", "folderId"],
      ["--folder-id", "folderId"],
    ]),
    jsonObjects: new Map([["--metadata", "metadata"]]),
    booleans: new Map<string, string>(),
  });
}

function parseDocsUpdateTitleOptions(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  return parseDocsFlags(args, docsUpdateTitleUsage, {
    strings: new Map([
      ["--doc-id", "docId"],
      ["--title", "title"],
    ]),
    jsonObjects: new Map<string, string>(),
    booleans: new Map<string, string>(),
  });
}

function parseDocsExportOptions(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  return parseDocsFlags(args, docsExportUsage, {
    strings: new Map([
      ["--doc-id", "docId"],
      ["--format", "format"],
      ["--filename", "filename"],
    ]),
    jsonObjects: new Map<string, string>(),
    booleans: new Map([["--include-comments", "includeComments"]]),
  });
}

function parseDocsCommentCreateOptions(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  return parseDocsFlags(args, docsCommentCreateUsage, {
    strings: new Map([
      ["--doc-id", "docId"],
      ["--body", "body"],
    ]),
    jsonObjects: new Map([
      ["--anchor", "anchor"],
      ["--metadata", "metadata"],
    ]),
    booleans: new Map<string, string>(),
  });
}

type DocsOptionSpec = {
  readonly strings: ReadonlyMap<string, string>;
  readonly jsonObjects: ReadonlyMap<string, string>;
  readonly booleans: ReadonlyMap<string, string>;
};

function parseDocsFlags(
  args: readonly string[],
  usageMessage: string,
  spec: DocsOptionSpec,
): JsonArgument {
  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const booleanField = spec.booleans.get(flag);
    if (booleanField !== undefined) {
      input[booleanField] = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      input[stringField] = value;
      index += 1;
      continue;
    }

    const jsonObjectField = spec.jsonObjects.get(flag);
    if (jsonObjectField !== undefined) {
      input[jsonObjectField] = parseJsonObjectFlag(value, usageMessage);
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }

  return { source: "inline", value: JSON.stringify(input) };
}

function parseJsonObjectFlag(value: string, usageMessage: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new CliUsageError(usageMessage);
  }
  throw new CliUsageError(usageMessage);
}

function parseCalendarCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  if (subject !== undefined && !subject.startsWith("--")) {
    throw new CliUsageError(calendarUsage);
  }
  switch (action) {
    case "event-create":
    case "create":
      return {
        kind: "tool-call",
        toolId: "calendar.event.create",
        json: parseTypedOptions(jsonArgs, calendarEventCreateOptions, calendarEventCreateUsage),
      };
    case "event-update":
    case "update":
      return {
        kind: "tool-call",
        toolId: "calendar.event.update",
        json: parseTypedOptions(jsonArgs, calendarEventUpdateOptions, calendarEventUpdateUsage),
      };
    case "event-delete":
    case "delete":
      return {
        kind: "tool-call",
        toolId: "calendar.event.delete",
        json: parseTypedOptions(jsonArgs, calendarEventDeleteOptions, calendarEventDeleteUsage),
      };
    case "event-respond":
    case "respond":
      return {
        kind: "tool-call",
        toolId: "calendar.event.respond",
        json: parseTypedOptions(jsonArgs, calendarEventRespondOptions, calendarEventRespondUsage),
      };
    case "find-time":
      return {
        kind: "tool-call",
        toolId: "calendar.find-time",
        json: parseTypedOptions(jsonArgs, calendarFindTimeOptions, calendarFindTimeUsage),
      };
    case "event-list":
    case "list":
      return {
        kind: "tool-call",
        toolId: "calendar.event.list",
        json: parseTypedOptions(jsonArgs, calendarEventListOptions, calendarEventListUsage),
      };
    default:
      throw new CliUsageError(calendarUsage);
  }
}

const calendarUsage =
  "Usage: helix calendar <event-create|event-update|event-delete|event-respond|event-list|find-time> [--json [JSON]]";
const calendarEventListUsage =
  "Usage: helix calendar event-list [--calendar-id <id>] [--start <iso>] [--end <iso>] [--limit <number>] [--json [JSON]]";

const calendarEventListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--calendar-id", "calendarId"],
    ["--start", "startsAt"],
    ["--end", "endsAt"],
  ]),
  numbers: new Map([["--limit", "limit"]]),
  booleans: new Map<string, string>(),
} as const;
const calendarEventCreateUsage =
  "Usage: helix calendar event-create [--calendar-id <id>] [--title <text>] [--description <text>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--location <text>] [--attendee <email>] [--json [JSON]]";
const calendarEventUpdateUsage =
  "Usage: helix calendar event-update [--event-id <id>] [--calendar-id <id>] [--title <text>] [--description <text>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--location <text>] [--attendee <email>] [--json [JSON]]";
const calendarEventDeleteUsage =
  "Usage: helix calendar event-delete [--event-id <id>] [--json [JSON]]";
const calendarEventRespondUsage =
  "Usage: helix calendar event-respond [--event-id <id>] [--response <accepted|declined|tentative>] [--comment <text>] [--json [JSON]]";
const calendarFindTimeUsage =
  "Usage: helix calendar find-time [--calendar-id <id>] [--attendee <email>] [--duration-minutes <number>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--json [JSON]]";

const calendarEventFields = new Map([
  ["--calendar-id", "calendarId"],
  ["--title", "title"],
  ["--description", "description"],
  ["--start", "startsAt"],
  ["--end", "endsAt"],
  ["--timezone", "timezone"],
  ["--location", "location"],
]);

const calendarEventCreateOptions = {
  arrays: new Map([["--attendee", "attendees"]]),
  strings: calendarEventFields,
  numbers: new Map<string, string>(),
  booleans: new Map([["--all-day", "allDay"]]),
} as const;

const calendarEventUpdateOptions = {
  arrays: new Map([["--attendee", "attendees"]]),
  strings: new Map([["--event-id", "eventId"], ...calendarEventFields]),
  numbers: new Map<string, string>(),
  booleans: new Map([["--all-day", "allDay"]]),
} as const;

const calendarEventDeleteOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--event-id", "eventId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map([["--send-cancellation", "sendCancellation"]]),
} as const;

const calendarEventRespondOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--event-id", "eventId"],
    ["--attendee-email", "attendeeEmail"],
    ["--rsvp-token", "rsvpToken"],
    ["--response", "responseStatus"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
  enums: new Map([["--response", new Set(["accepted", "declined", "tentative"])]]),
} as const;

const calendarFindTimeOptions = {
  arrays: new Map([
    ["--attendee", "attendeeEmails"],
    ["--attendee-email", "attendeeEmails"],
    ["--attendee-actor-id", "attendeeActorIds"],
  ]),
  strings: new Map([
    ["--start", "windowStartsAt"],
    ["--end", "windowEndsAt"],
  ]),
  numbers: new Map([
    ["--duration-minutes", "durationMinutes"],
    ["--step-minutes", "stepMinutes"],
    ["--limit", "limit"],
  ]),
  booleans: new Map<string, string>(),
} as const;

function parseMeetCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  if (subject !== undefined && !subject.startsWith("--")) {
    throw new CliUsageError(meetUsage);
  }
  switch (action) {
    case "create-room":
    case "create":
      return {
        kind: "tool-call",
        toolId: "meet.create-room",
        json: parseTypedOptions(jsonArgs, meetCreateRoomOptions, meetCreateRoomUsage),
      };
    case "list":
    case "rooms":
      return {
        kind: "tool-call",
        toolId: "meet.room.list",
        json: parseTypedOptions(jsonArgs, meetRoomListOptions, meetRoomListUsage),
      };
    case "mint-token":
    case "token":
      return {
        kind: "tool-call",
        toolId: "meet.mint-token",
        json: parseTypedOptions(jsonArgs, meetMintTokenOptions, meetMintTokenUsage),
      };
    case "end-room":
    case "end":
      return {
        kind: "tool-call",
        toolId: "meet.end-room",
        json: parseTypedOptions(jsonArgs, meetEndRoomOptions, meetEndRoomUsage),
      };
    default:
      throw new CliUsageError(meetUsage);
  }
}

const meetUsage = "Usage: helix meet <create-room|list|mint-token|end-room> [--json [JSON]]";
const meetCreateRoomUsage =
  "Usage: helix meet create-room [--subject <text>] [--room-name <name>] [--jitsi-domain <domain>] [--participant <actor-id>] [--json [JSON]]";
const meetRoomListUsage =
  "Usage: helix meet list [--status <active|ended>] [--limit <n>] [--json [JSON]]";
const meetMintTokenUsage =
  "Usage: helix meet mint-token [--room-id <id>] [--expires-in-seconds <n>] [--moderator] [--json [JSON]]";
const meetEndRoomUsage = "Usage: helix meet end-room [--room-id <id>] [--json [JSON]]";

const meetCreateRoomOptions = {
  arrays: new Map([
    ["--participant", "participantActorIds"],
    ["--participant-actor-id", "participantActorIds"],
  ]),
  strings: new Map([
    ["--subject", "subject"],
    ["--room-name", "roomName"],
    ["--jitsi-domain", "jitsiDomain"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const meetRoomListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--status", "status"]]),
  numbers: new Map([["--limit", "limit"]]),
  booleans: new Map<string, string>(),
  enums: new Map([["--status", new Set(["active", "ended"])]]),
} as const;

const meetMintTokenOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--room-id", "roomId"]]),
  numbers: new Map([["--expires-in-seconds", "expiresInSeconds"]]),
  booleans: new Map([["--moderator", "moderator"]]),
} as const;

const meetEndRoomOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--room-id", "roomId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

function parseAssistantCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  const jsonArgs = subject === undefined ? rest : [subject, ...rest];
  if (subject !== undefined && !subject.startsWith("--")) {
    throw new CliUsageError(assistantUsage);
  }
  switch (action) {
    case "chat":
    case "ask":
      return { kind: "tool-call", toolId: "assistant.chat", json: parseJsonArgument(jsonArgs) };
    case "new":
    case "conversation-create":
      return {
        kind: "tool-call",
        toolId: "assistant.conversation.create",
        json: parseJsonArgument(jsonArgs),
      };
    case "forget":
    case "memory-forget":
      return {
        kind: "tool-call",
        toolId: "assistant.memory.forget",
        json: parseJsonArgument(jsonArgs),
      };
    case "approve":
    case "confirmation-approve":
      return {
        kind: "tool-call",
        toolId: "assistant.confirmation.approve",
        json: parseTypedOptions(jsonArgs, assistantConfirmationOptions, assistantConfirmationUsage),
      };
    case "cancel":
    case "confirmation-cancel":
      return {
        kind: "tool-call",
        toolId: "assistant.confirmation.cancel",
        json: parseTypedOptions(jsonArgs, assistantConfirmationOptions, assistantConfirmationUsage),
      };
    default:
      throw new CliUsageError(assistantUsage);
  }
}

const assistantUsage = "Usage: helix assistant <chat|new|forget|approve|cancel> [--json [JSON]]";
const assistantConfirmationUsage =
  "Usage: helix assistant <approve|cancel> [--conversation-id <id>] [--pending-id <id>] [--classification <public|standard|confidential|restricted>] [--json [JSON]]";

const assistantConfirmationOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--conversation-id", "conversationId"],
    ["--pending-id", "pendingId"],
    ["--classification", "classification"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
  enums: new Map([
    ["--classification", new Set(["public", "standard", "confidential", "restricted"])],
  ]),
} as const;

function parseSearchCommand(args: readonly string[]): HelixCommand {
  if (args.length === 0) {
    throw new CliUsageError(searchUsage);
  }

  if (args[0] === "--json") {
    return { kind: "tool-call", toolId: "search.query", json: parseJsonArgument(args) };
  }

  const input: Record<string, unknown> = {};
  const positionalQuery: string[] = [];
  const types: SearchType[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      throw new CliUsageError(searchUsage);
    }

    if (!arg.startsWith("--")) {
      positionalQuery.push(arg);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(searchUsage);
    }

    if (arg === "--query") {
      input.query = value;
      index += 1;
      continue;
    }

    if (arg === "--type" || arg === "--types") {
      for (const type of parseCommaSeparatedValues(value)) {
        if (!isSearchType(type)) {
          throw new CliUsageError(searchUsage);
        }
        types.push(type);
      }
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      input.limit = parsePositiveInteger(value, searchUsage);
      index += 1;
      continue;
    }

    throw new CliUsageError(searchUsage);
  }

  if (input.query !== undefined && positionalQuery.length > 0) {
    throw new CliUsageError(searchUsage);
  }

  const query =
    typeof input.query === "string" && input.query.trim().length > 0
      ? input.query
      : positionalQuery.join(" ");
  if (query.trim().length === 0) {
    throw new CliUsageError(searchUsage);
  }

  input.query = query;
  if (types.length > 0) {
    input.types = [...new Set(types)];
  }

  return { kind: "tool-call", toolId: "search.query", json: inlineJson(input) };
}

const searchUsage =
  "Usage: helix search <query> | helix search --query <text> [--type <mail|chat|docs|drive|calendar>] [--limit <number>] [--json [JSON]]";

const searchTypes = new Set<SearchType>(["mail", "chat", "docs", "drive", "calendar"]);

function isSearchType(value: string): value is SearchType {
  return searchTypes.has(value as SearchType);
}

function parseAdminCommand(
  family: string | undefined,
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (family) {
    case "app-passwords":
      return parseAdminAppPasswordsCommand(action, args);
    case "agent-credentials":
    case "credentials":
      return parseAdminAgentCredentialsCommand(action, args);
    case "users":
      return parseAdminUsersCommand(action, args);
    case "audit":
    case "audit-log":
      return parseAdminAuditCommand(action, args);
    case "storage":
      return parseAdminStorageCommand(action, args);
    case "storage-migrations":
      return parseAdminStorageMigrationsCommand(action, args);
    case "tenant-exports":
      return parseAdminTenantExportsCommand(action, args);
    case "tenant-imports":
      return parseAdminTenantImportsCommand(action, args);
    default:
      throw new CliUsageError(adminUsage);
  }
}

function parseAdminAppPasswordsCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "list":
      return {
        kind: "tool-call",
        toolId: "app.passwords.list",
        json: parseTypedOptions(args, adminAppPasswordsListOptions, adminAppPasswordsListUsage),
      };
    case "create":
      return {
        kind: "tool-call",
        toolId: "app.passwords.create",
        json: parseTypedOptions(args, adminAppPasswordsCreateOptions, adminAppPasswordsCreateUsage),
      };
    case "revoke":
      return {
        kind: "tool-call",
        toolId: "app.passwords.revoke",
        json: parseTypedOptions(args, adminAppPasswordsRevokeOptions, adminAppPasswordsRevokeUsage),
      };
    default:
      throw new CliUsageError(adminAppPasswordsUsage);
  }
}

function parseAdminAgentCredentialsCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "list":
      return {
        kind: "tool-call",
        toolId: "agent.credentials.list",
        json: parseTypedOptions(
          args,
          adminAgentCredentialsListOptions,
          adminAgentCredentialsListUsage,
        ),
      };
    case "create":
      return {
        kind: "tool-call",
        toolId: "agent.credentials.create",
        json: parseTypedOptions(
          args,
          adminAgentCredentialsCreateOptions,
          adminAgentCredentialsCreateUsage,
        ),
      };
    case "revoke":
      return {
        kind: "tool-call",
        toolId: "agent.credentials.revoke",
        json: parseTypedOptions(
          args,
          adminAgentCredentialsRevokeOptions,
          adminAgentCredentialsRevokeUsage,
        ),
      };
    default:
      throw new CliUsageError(adminAgentCredentialsUsage);
  }
}

function parseAdminUsersCommand(action: string | undefined, args: readonly string[]): HelixCommand {
  if (action !== "list") {
    throw new CliUsageError(adminUsersUsage);
  }

  const input: {
    query?: string;
    type?: AdminUserType;
    includeDisabled?: boolean;
    limit?: number;
    cursor?: string;
  } = {};
  parseAdminGetFlags(args, adminUsersListUsage, {
    strings: new Map([
      ["--query", "query"],
      ["--cursor", "cursor"],
    ]),
    numbers: new Map([["--limit", "limit"]]),
    booleans: new Map([["--include-disabled", "includeDisabled"]]),
    enums: new Map([["--type", adminUserTypes]]),
    enumFields: new Map([["--type", "type"]]),
    input,
  });
  return { kind: "admin-users-list", ...input };
}

function parseAdminAuditCommand(action: string | undefined, args: readonly string[]): HelixCommand {
  if (action !== "list") {
    throw new CliUsageError(adminAuditUsage);
  }

  const input: {
    actorId?: string;
    objectId?: string;
    objectType?: string;
    verb?: string;
    limit?: number;
    cursor?: string;
  } = {};
  parseAdminGetFlags(args, adminAuditListUsage, {
    strings: new Map([
      ["--actor-id", "actorId"],
      ["--object-id", "objectId"],
      ["--object-type", "objectType"],
      ["--verb", "verb"],
      ["--cursor", "cursor"],
    ]),
    numbers: new Map([["--limit", "limit"]]),
    booleans: new Map<string, string>(),
    enums: new Map<string, ReadonlySet<string>>(),
    enumFields: new Map<string, string>(),
    input,
  });
  return { kind: "admin-audit-list", ...input };
}

function parseAdminStorageCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  if (action !== "test" || args.length > 0) {
    throw new CliUsageError(adminStorageUsage);
  }
  return { kind: "admin-storage-test" };
}

function parseAdminStorageMigrationsCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "list":
      return parseAdminStorageMigrationListCommand(args);
    case "request":
      return parseAdminStorageMigrationRequestCommand(args);
    case "get":
    case "status":
      return parseAdminStorageMigrationGetCommand(args);
    case "cutover":
      return parseAdminStorageMigrationCutoverCommand(args);
    default:
      throw new CliUsageError(adminStorageMigrationsUsage);
  }
}

function parseAdminStorageMigrationListCommand(args: readonly string[]): HelixCommand {
  const input: {
    target?: TenantStorageMigrationTarget;
    status?: TenantStorageMigrationStatus;
    limit?: number;
    cursor?: string;
  } = {};
  parseAdminGetFlags(args, adminStorageMigrationsListUsage, {
    strings: new Map([["--cursor", "cursor"]]),
    numbers: new Map([["--limit", "limit"]]),
    booleans: new Map<string, string>(),
    enums: new Map<string, ReadonlySet<string>>([
      ["--target", tenantStorageMigrationTargets],
      ["--status", tenantStorageMigrationStatuses],
    ]),
    enumFields: new Map([
      ["--target", "target"],
      ["--status", "status"],
    ]),
    input,
  });
  return { kind: "admin-storage-migration-list", ...input };
}

function parseAdminStorageMigrationRequestCommand(args: readonly string[]): HelixCommand {
  let target: TenantStorageMigrationTarget | undefined;
  let dryRun = true;
  let liveRequested = false;
  let liveConfirmed = false;
  let sourceStorage: Record<string, unknown> | undefined;
  let targetStorage: Record<string, unknown> | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(adminStorageMigrationsRequestUsage);
    }

    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--live") {
      dryRun = false;
      liveRequested = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(adminStorageMigrationsRequestUsage);
    }

    if (flag === "--target") {
      if (!isTenantStorageMigrationTarget(value)) {
        throw new CliUsageError(adminStorageMigrationsRequestUsage);
      }
      target = value;
      index += 1;
      continue;
    }
    if (flag === "--source-storage") {
      sourceStorage = parseJsonObjectFlag(value, adminStorageMigrationsRequestUsage);
      index += 1;
      continue;
    }
    if (flag === "--target-storage") {
      targetStorage = parseJsonObjectFlag(value, adminStorageMigrationsRequestUsage);
      index += 1;
      continue;
    }
    if (flag === "--confirm") {
      if (value !== "LIVE") {
        throw new CliUsageError(adminStorageMigrationsRequestUsage);
      }
      liveConfirmed = true;
      index += 1;
      continue;
    }

    throw new CliUsageError(adminStorageMigrationsRequestUsage);
  }

  if (target === undefined || (liveRequested && !liveConfirmed)) {
    throw new CliUsageError(adminStorageMigrationsRequestUsage);
  }

  return {
    kind: "admin-storage-migration-request",
    target,
    dryRun,
    ...(sourceStorage === undefined ? {} : { sourceStorage }),
    ...(targetStorage === undefined ? {} : { targetStorage }),
  };
}

function parseAdminStorageMigrationGetCommand(args: readonly string[]): HelixCommand {
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith("-")) {
    throw new CliUsageError(adminStorageMigrationsGetUsage);
  }
  return { kind: "admin-storage-migration-get", migrationId: args[0] };
}

function parseAdminStorageMigrationCutoverCommand(args: readonly string[]): HelixCommand {
  if (args.length !== 3 || args[0] === undefined || args[0].startsWith("-")) {
    throw new CliUsageError(adminStorageMigrationsCutoverUsage);
  }
  if (args[1] !== "--confirm" || args[2] !== "CUTOVER") {
    throw new CliUsageError(adminStorageMigrationsCutoverUsage);
  }
  return { kind: "admin-storage-migration-cutover", migrationId: args[0] };
}

function parseAdminTenantExportsCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "queue":
      return parseTenantExportQueueCommand(args[0], args.slice(1));
    case "list":
      return parseTenantExportListCommand(args[0], args.slice(1));
    case "get":
    case "status":
      return parseTenantExportStatusCommand(args[0], args.slice(1));
    case "download":
      return parseTenantExportDownloadCommand(args[0], args.slice(1));
    default:
      throw new CliUsageError(adminTenantExportsUsage);
  }
}

function parseTenantExportQueueCommand(
  slug: string | undefined,
  args: readonly string[],
): HelixCommand {
  if (slug === undefined || slug.startsWith("-")) {
    throw new CliUsageError(adminTenantExportsQueueUsage);
  }
  let includeObjectBytes = true;
  let presignedUrlExpiresSeconds: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--include-object-bytes") {
      includeObjectBytes = true;
      continue;
    }
    if (flag === "--metadata-only") {
      includeObjectBytes = false;
      continue;
    }
    if (flag === "--presigned-url-expires-seconds") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(adminTenantExportsQueueUsage);
      }
      presignedUrlExpiresSeconds = parsePositiveInteger(value, adminTenantExportsQueueUsage);
      index += 1;
      continue;
    }
    throw new CliUsageError(adminTenantExportsQueueUsage);
  }

  return {
    kind: "tenant-export-queue",
    slug,
    includeObjectBytes,
    ...(presignedUrlExpiresSeconds === undefined ? {} : { presignedUrlExpiresSeconds }),
  };
}

function parseTenantExportListCommand(
  slug: string | undefined,
  args: readonly string[],
): HelixCommand {
  if (slug === undefined || slug.startsWith("-")) {
    throw new CliUsageError(adminTenantExportsListUsage);
  }
  const input: {
    status?: TenantExportJobStatus;
    limit?: number;
    cursor?: string;
  } = {};
  parseAdminGetFlags(args, adminTenantExportsListUsage, {
    strings: new Map([["--cursor", "cursor"]]),
    numbers: new Map([["--limit", "limit"]]),
    booleans: new Map<string, string>(),
    enums: new Map([["--status", tenantExportJobStatuses]]),
    enumFields: new Map([["--status", "status"]]),
    input,
  });
  return { kind: "tenant-export-list", slug, ...input };
}

function parseTenantExportStatusCommand(
  slug: string | undefined,
  args: readonly string[],
): HelixCommand {
  if (slug === undefined || slug.startsWith("-") || args.length !== 1 || args[0] === undefined) {
    throw new CliUsageError(adminTenantExportsStatusUsage);
  }
  return { kind: "tenant-export-status", slug, jobId: args[0] };
}

function parseTenantExportDownloadCommand(
  slug: string | undefined,
  args: readonly string[],
): HelixCommand {
  const jobId = args[0];
  if (slug === undefined || slug.startsWith("-") || jobId === undefined || jobId.startsWith("-")) {
    throw new CliUsageError(adminTenantExportsDownloadUsage);
  }

  let output: string | undefined;
  let force = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--output") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(adminTenantExportsDownloadUsage);
      }
      output = value;
      index += 1;
      continue;
    }
    if (flag === "--force") {
      force = true;
      continue;
    }
    throw new CliUsageError(adminTenantExportsDownloadUsage);
  }

  if (output === undefined) {
    throw new CliUsageError(adminTenantExportsDownloadUsage);
  }
  return { kind: "tenant-export-download", slug, jobId, output, force };
}

const adminTenantExportsUsage =
  "Usage: helix admin tenant-exports <queue|list|status|download> <slug> [options]";
const adminTenantExportsQueueUsage =
  "Usage: helix admin tenant-exports queue <slug> [--include-object-bytes | --metadata-only] [--presigned-url-expires-seconds <seconds>]";
const adminTenantExportsListUsage =
  "Usage: helix admin tenant-exports list <slug> [--status <queued|running|succeeded|failed>] [--limit <number>] [--cursor <cursor>]";
const adminTenantExportsStatusUsage = "Usage: helix admin tenant-exports status <slug> <job-id>";
const adminTenantExportsDownloadUsage =
  "Usage: helix admin tenant-exports download <slug> <job-id> --output <path> [--force]";

function parseAdminTenantImportsCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "dry-run":
      return parseTenantImportDryRunCommand(args[0], args[1], args.slice(2));
    default:
      throw new CliUsageError(adminTenantImportsUsage);
  }
}

function parseTenantImportDryRunCommand(
  slug: string | undefined,
  archive: string | undefined,
  args: readonly string[],
): HelixCommand {
  if (
    slug === undefined ||
    slug.startsWith("-") ||
    archive === undefined ||
    archive.startsWith("-") ||
    args.length > 0
  ) {
    throw new CliUsageError(adminTenantImportsDryRunUsage);
  }
  return { kind: "tenant-import-dry-run", slug, archive };
}

const adminTenantImportsUsage = "Usage: helix admin tenant-imports dry-run <slug> <archive-path>";
const adminTenantImportsDryRunUsage =
  "Usage: helix admin tenant-imports dry-run <slug> <archive-path>";

const adminUsage =
  "Usage: helix admin <app-passwords|agent-credentials|users|audit|storage|storage-migrations|tenant-exports|tenant-imports> <command> [--json [JSON]]";
const adminAppPasswordsUsage =
  "Usage: helix admin app-passwords <list|create|revoke> [--json [JSON]]";
const adminAppPasswordsListUsage =
  "Usage: helix admin app-passwords list [--actor-id <id>] [--include-revoked] [--json [JSON]]";
const adminAppPasswordsCreateUsage =
  "Usage: helix admin app-passwords create [--actor-id <id>] [--label <label>] [--scope <scope>] [--expires-at <iso>] [--json [JSON]]";
const adminAppPasswordsRevokeUsage =
  "Usage: helix admin app-passwords revoke [--password-id <id>] [--json [JSON]]";
const adminAgentCredentialsUsage =
  "Usage: helix admin agent-credentials <list|create|revoke> [--json [JSON]]";
const adminAgentCredentialsListUsage =
  "Usage: helix admin agent-credentials list [--actor-id <id>] [--include-revoked] [--json [JSON]]";
const adminAgentCredentialsCreateUsage =
  "Usage: helix admin agent-credentials create [--actor-id <id>] [--scope <scope>] [--expires-at <iso>] [--json [JSON]]";
const adminAgentCredentialsRevokeUsage =
  "Usage: helix admin agent-credentials revoke [--client-id <id>] [--json [JSON]]";
const adminUsersUsage =
  "Usage: helix admin users list [--query <text>] [--type <user|agent|service_account|system>] [--include-disabled] [--limit <number>] [--cursor <cursor>]";
const adminUsersListUsage = adminUsersUsage;
const adminAuditUsage =
  "Usage: helix admin audit list [--actor-id <id>] [--object-id <id>] [--object-type <type>] [--verb <verb>] [--limit <number>] [--cursor <cursor>]";
const adminAuditListUsage = adminAuditUsage;
const adminStorageUsage = "Usage: helix admin storage test";
const adminStorageMigrationsUsage =
  "Usage: helix admin storage-migrations <list|request|get|status|cutover>";
const adminStorageMigrationsListUsage =
  "Usage: helix admin storage-migrations list [--target <byo|helix-default>] [--status <queued|running|succeeded|succeeded_with_errors|failed|dry_run>] [--limit <number>] [--cursor <cursor>]";
const adminStorageMigrationsRequestUsage =
  "Usage: helix admin storage-migrations request --target <byo|helix-default> [--dry-run | --live --confirm LIVE] [--source-storage <json-object>] [--target-storage <json-object>]";
const adminStorageMigrationsGetUsage =
  "Usage: helix admin storage-migrations <get|status> <migration-id>";
const adminStorageMigrationsCutoverUsage =
  "Usage: helix admin storage-migrations cutover <migration-id> --confirm CUTOVER";

const adminAppPasswordsListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--actor-id", "actorId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map([["--include-revoked", "includeRevoked"]]),
} as const;

const adminAppPasswordsCreateOptions = {
  arrays: new Map([["--scope", "scopes"]]),
  strings: new Map([
    ["--actor-id", "actorId"],
    ["--label", "label"],
    ["--expires-at", "expiresAt"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const adminAppPasswordsRevokeOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--password-id", "passwordId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const adminAgentCredentialsListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--actor-id", "actorId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map([["--include-revoked", "includeRevoked"]]),
} as const;

const adminAgentCredentialsCreateOptions = {
  arrays: new Map([["--scope", "scopes"]]),
  strings: new Map([
    ["--actor-id", "actorId"],
    ["--expires-at", "expiresAt"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const adminAgentCredentialsRevokeOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--client-id", "clientId"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, string>(),
} as const;

const adminUserTypes = new Set<AdminUserType>(["user", "agent", "service_account", "system"]);
const securityTiers = new Set<SecurityTier>(["personal", "business", "enterprise", "sovereign"]);
const tenantStorageMigrationTargets = new Set<TenantStorageMigrationTarget>([
  "byo",
  "helix-default",
]);
const tenantStorageMigrationStatuses = new Set<TenantStorageMigrationStatus>([
  "queued",
  "running",
  "succeeded",
  "succeeded_with_errors",
  "failed",
  "dry_run",
]);
const tenantExportJobStatuses = new Set<TenantExportJobStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

function parseBackupCommand(
  action: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
): HelixCommand {
  if (action !== "create" || subject !== undefined || rest.length > 0) {
    throw new CliUsageError(backupCreateUsage);
  }
  return { kind: "backup-create" };
}

function parseRestoreCommand(args: readonly string[]): HelixCommand {
  let backupId: string | undefined;
  let encrypted = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(restoreFromUsage);
      }
      backupId = value;
      index += 1;
    } else if (arg === "--encrypted") {
      encrypted = true;
    } else {
      throw new CliUsageError(restoreFromUsage);
    }
  }
  if (backupId === undefined || backupId.trim().length === 0) {
    throw new CliUsageError(restoreFromUsage);
  }
  return { kind: "restore-from", backupId, ...(encrypted ? { encrypted } : {}) };
}

const backupCreateUsage = "Usage: helix backup create";
const restoreFromUsage = "Usage: helix restore --from <backup-id> [--encrypted]";
const reindexAllUsage = "Usage: helix reindex --all";

function parseReindexCommand(args: readonly string[]): HelixCommand {
  if (args.length !== 1 || args[0] !== "--all") {
    throw new CliUsageError(reindexAllUsage);
  }
  return { kind: "reindex-all" };
}

function parseActionCommand(
  action: string | undefined,
  actionId: string | undefined,
  rest: readonly string[],
): HelixCommand {
  if (actionId === undefined || actionId.startsWith("-") || rest.length > 0) {
    throw new CliUsageError(actionUsage);
  }

  switch (action) {
    case "status":
      return { kind: "action-status", actionId };
    case "approve":
      return { kind: "action-approve", actionId };
    case "cancel":
      return { kind: "action-cancel", actionId };
    default:
      throw new CliUsageError(actionUsage);
  }
}

const actionUsage = "Usage: helix action <status|approve|cancel> <action-id>";

function parseTierCommand(
  action: string | undefined,
  tier: string | undefined,
  rest: readonly string[],
): HelixCommand {
  if (action !== "set" || tier === undefined || rest.length > 0 || !isSecurityTier(tier)) {
    throw new CliUsageError(tierSetUsage);
  }
  return { kind: "tier-set", tier };
}

function isSecurityTier(value: string): value is SecurityTier {
  return securityTiers.has(value as SecurityTier);
}

function isTenantStorageMigrationTarget(value: string): value is TenantStorageMigrationTarget {
  return tenantStorageMigrationTargets.has(value as TenantStorageMigrationTarget);
}

const tierSetUsage = "Usage: helix tier set <personal|business|enterprise|sovereign>";

type AdminGetFlagSpec = {
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
  readonly booleans: ReadonlyMap<string, string>;
  readonly enums: ReadonlyMap<string, ReadonlySet<string>>;
  readonly enumFields: ReadonlyMap<string, string>;
  readonly input: Record<string, unknown>;
};

function parseAdminGetFlags(
  args: readonly string[],
  usageMessage: string,
  spec: AdminGetFlagSpec,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const booleanField = spec.booleans.get(flag);
    if (booleanField !== undefined) {
      spec.input[booleanField] = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const enumValues = spec.enums.get(flag);
    if (enumValues !== undefined) {
      if (!enumValues.has(value)) {
        throw new CliUsageError(usageMessage);
      }
      const field = spec.enumFields.get(flag);
      if (field === undefined) {
        throw new CliUsageError(usageMessage);
      }
      spec.input[field] = value;
      index += 1;
      continue;
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      spec.input[stringField] = value;
      index += 1;
      continue;
    }

    const numberField = spec.numbers.get(flag);
    if (numberField !== undefined) {
      spec.input[numberField] = parsePositiveInteger(value, usageMessage);
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }
}

function parseWebhookCommand(
  family: string | undefined,
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (family) {
    case "outbound":
      return parseWebhookOutboundCommand(action, args);
    case "inbound":
      return parseWebhookInboundCommand(action, args);
    case "delivery":
      return parseWebhookDeliveryCommand(action, args);
    default:
      throw new CliUsageError(webhookUsage);
  }
}

function parseWebhookOutboundCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "create":
      return {
        kind: "tool-call",
        toolId: "webhook.outbound.create",
        json: parseWebhookOptions(args, webhookOutboundCreateOptions, webhookOutboundCreateUsage),
      };
    case "update":
      return {
        kind: "tool-call",
        toolId: "webhook.outbound.update",
        json: parseWebhookOptions(args, webhookOutboundUpdateOptions, webhookOutboundUpdateUsage),
      };
    case "delete":
      return {
        kind: "tool-call",
        toolId: "webhook.outbound.delete",
        json: parseWebhookOptions(args, webhookIdOptions, webhookOutboundDeleteUsage),
      };
    case "list":
      return {
        kind: "tool-call",
        toolId: "webhook.outbound.list",
        json: parseWebhookOptions(args, emptyWebhookOptions, webhookOutboundListUsage),
      };
    case "test":
      return {
        kind: "tool-call",
        toolId: "webhook.outbound.test",
        json: parseWebhookOptions(args, webhookOutboundTestOptions, webhookOutboundTestUsage),
      };
    case "replay":
      return {
        kind: "tool-call",
        toolId: "webhook.outbound.replay",
        json: parseWebhookOptions(args, webhookOutboundReplayOptions, webhookOutboundReplayUsage),
      };
    default:
      throw new CliUsageError(webhookOutboundUsage);
  }
}

function parseWebhookInboundCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "create":
      return {
        kind: "tool-call",
        toolId: "webhook.inbound.create",
        json: parseWebhookOptions(args, webhookInboundCreateOptions, webhookInboundCreateUsage),
      };
    case "update":
      return {
        kind: "tool-call",
        toolId: "webhook.inbound.update",
        json: parseWebhookOptions(args, webhookInboundUpdateOptions, webhookInboundUpdateUsage),
      };
    case "delete":
      return {
        kind: "tool-call",
        toolId: "webhook.inbound.delete",
        json: parseWebhookOptions(args, webhookIdOptions, webhookInboundDeleteUsage),
      };
    case "rotate-secret":
      return {
        kind: "tool-call",
        toolId: "webhook.inbound.rotate-secret",
        json: parseWebhookOptions(args, webhookIdOptions, webhookInboundRotateSecretUsage),
      };
    case "list":
      return {
        kind: "tool-call",
        toolId: "webhook.inbound.list",
        json: parseWebhookOptions(args, emptyWebhookOptions, webhookInboundListUsage),
      };
    default:
      throw new CliUsageError(webhookInboundUsage);
  }
}

function parseWebhookDeliveryCommand(
  action: string | undefined,
  args: readonly string[],
): HelixCommand {
  switch (action) {
    case "get":
      return {
        kind: "tool-call",
        toolId: "webhook.delivery.get",
        json: parseWebhookOptions(args, webhookIdOptions, webhookDeliveryGetUsage),
      };
    case "list":
      return {
        kind: "tool-call",
        toolId: "webhook.delivery.list",
        json: parseWebhookOptions(args, webhookDeliveryListOptions, webhookDeliveryListUsage),
      };
    default:
      throw new CliUsageError(webhookDeliveryUsage);
  }
}

const webhookUsage = "Usage: helix webhook <outbound|inbound|delivery> <command> [--json [JSON]]";
const webhookOutboundUsage =
  "Usage: helix webhook outbound <create|update|delete|list|test|replay> [--json [JSON]]";
const webhookInboundUsage =
  "Usage: helix webhook inbound <create|update|delete|rotate-secret|list> [--json [JSON]]";
const webhookDeliveryUsage = "Usage: helix webhook delivery <get|list> [--json [JSON]]";
const webhookOutboundCreateUsage =
  "Usage: helix webhook outbound create [--name <name>] [--url <url>] [--event-subject <subject>] [--secret-ref <ref>] [--header <name=value>] [--headers <json-object>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]";
const webhookOutboundUpdateUsage =
  "Usage: helix webhook outbound update [--id <id>] [--name <name>] [--url <url>] [--event-subject <subject>] [--secret-ref <ref>] [--header <name=value>] [--headers <json-object>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]";
const webhookOutboundDeleteUsage =
  "Usage: helix webhook outbound delete [--id <id>] [--json [JSON]]";
const webhookOutboundListUsage = "Usage: helix webhook outbound list [--json [JSON]]";
const webhookOutboundTestUsage =
  "Usage: helix webhook outbound test [--id <id>] [--subject <subject>] [--payload <json>] [--json [JSON]]";
const webhookOutboundReplayUsage =
  "Usage: helix webhook outbound replay [--delivery-id <id>] [--id <id>] [--json [JSON]]";
const webhookInboundCreateUsage =
  "Usage: helix webhook inbound create [--name <name>] [--slug <slug>] [--source <source>] [--secret-ref <ref>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]";
const webhookInboundUpdateUsage =
  "Usage: helix webhook inbound update [--id <id>] [--name <name>] [--slug <slug>] [--source <source>] [--secret-ref <ref>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]";
const webhookInboundDeleteUsage = "Usage: helix webhook inbound delete [--id <id>] [--json [JSON]]";
const webhookInboundRotateSecretUsage =
  "Usage: helix webhook inbound rotate-secret [--id <id>] [--json [JSON]]";
const webhookInboundListUsage = "Usage: helix webhook inbound list [--json [JSON]]";
const webhookDeliveryGetUsage = "Usage: helix webhook delivery get [--id <id>] [--json [JSON]]";
const webhookDeliveryListUsage =
  "Usage: helix webhook delivery list [--direction <outbound|inbound>] [--status <pending|in_progress|delivered|failed|abandoned>] [--limit <number>] [--json [JSON]]";

const webhookEnabledOptions = new Map([
  ["--enabled", { field: "enabled", value: true }],
  ["--disabled", { field: "enabled", value: false }],
]);

const webhookOutboundBaseOptions = {
  arrays: new Map([["--event-subject", "eventSubjects"]]),
  strings: new Map([
    ["--name", "name"],
    ["--url", "url"],
    ["--secret-ref", "secretRef"],
  ]),
  numbers: new Map<string, string>(),
  booleans: webhookEnabledOptions,
  jsonObjects: new Map([
    ["--headers", "headers"],
    ["--metadata", "metadata"],
  ]),
  jsonValues: new Map<string, string>(),
  keyValues: new Map([["--header", "headers"]]),
} as const;

const webhookOutboundCreateOptions = webhookOutboundBaseOptions;
const webhookOutboundUpdateOptions = {
  ...webhookOutboundBaseOptions,
  strings: new Map([["--id", "id"], ...webhookOutboundBaseOptions.strings]),
} as const;

const webhookOutboundTestOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--id", "id"],
    ["--subject", "subject"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, WebhookBooleanOption>(),
  jsonObjects: new Map<string, string>(),
  jsonValues: new Map([["--payload", "payload"]]),
  keyValues: new Map<string, string>(),
} as const;

const webhookOutboundReplayOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--delivery-id", "deliveryId"],
    ["--id", "id"],
  ]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, WebhookBooleanOption>(),
  jsonObjects: new Map<string, string>(),
  jsonValues: new Map<string, string>(),
  keyValues: new Map<string, string>(),
} as const;

const webhookInboundBaseOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--name", "name"],
    ["--slug", "slug"],
    ["--source", "source"],
    ["--secret-ref", "secretRef"],
  ]),
  numbers: new Map<string, string>(),
  booleans: webhookEnabledOptions,
  jsonObjects: new Map([["--metadata", "metadata"]]),
  jsonValues: new Map<string, string>(),
  keyValues: new Map<string, string>(),
} as const;

const webhookInboundCreateOptions = webhookInboundBaseOptions;
const webhookInboundUpdateOptions = {
  ...webhookInboundBaseOptions,
  strings: new Map([["--id", "id"], ...webhookInboundBaseOptions.strings]),
} as const;

const webhookIdOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([["--id", "id"]]),
  numbers: new Map<string, string>(),
  booleans: new Map<string, WebhookBooleanOption>(),
  jsonObjects: new Map<string, string>(),
  jsonValues: new Map<string, string>(),
  keyValues: new Map<string, string>(),
} as const;

const webhookDeliveryListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--direction", "direction"],
    ["--status", "status"],
  ]),
  numbers: new Map([["--limit", "limit"]]),
  booleans: new Map<string, WebhookBooleanOption>(),
  jsonObjects: new Map<string, string>(),
  jsonValues: new Map<string, string>(),
  keyValues: new Map<string, string>(),
  enums: new Map([
    ["--direction", new Set(["outbound", "inbound"])],
    ["--status", new Set(["pending", "in_progress", "delivered", "failed", "abandoned"])],
  ]),
} as const;

const emptyWebhookOptions = {
  arrays: new Map<string, string>(),
  strings: new Map<string, string>(),
  numbers: new Map<string, string>(),
  booleans: new Map<string, WebhookBooleanOption>(),
  jsonObjects: new Map<string, string>(),
  jsonValues: new Map<string, string>(),
  keyValues: new Map<string, string>(),
} as const;

type WebhookBooleanOption = {
  readonly field: string;
  readonly value: boolean;
};

type WebhookOptionSpec = {
  readonly arrays: ReadonlyMap<string, string>;
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
  readonly booleans: ReadonlyMap<string, WebhookBooleanOption>;
  readonly jsonObjects: ReadonlyMap<string, string>;
  readonly jsonValues: ReadonlyMap<string, string>;
  readonly keyValues: ReadonlyMap<string, string>;
  readonly enums?: ReadonlyMap<string, ReadonlySet<string>>;
};

function parseWebhookOptions(
  args: readonly string[],
  spec: WebhookOptionSpec,
  usageMessage: string,
): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const booleanOption = spec.booleans.get(flag);
    if (booleanOption !== undefined) {
      input[booleanOption.field] = booleanOption.value;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const arrayField = spec.arrays.get(flag);
    if (arrayField !== undefined) {
      input[arrayField] = [
        ...readStringArray(input[arrayField]),
        ...parseCommaSeparatedValues(value),
      ];
      index += 1;
      continue;
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      const allowedValues = spec.enums?.get(flag);
      if (allowedValues !== undefined && !allowedValues.has(value)) {
        throw new CliUsageError(usageMessage);
      }
      input[stringField] = value;
      index += 1;
      continue;
    }

    const numberField = spec.numbers.get(flag);
    if (numberField !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new CliUsageError(usageMessage);
      }
      input[numberField] = parsed;
      index += 1;
      continue;
    }

    const jsonObjectField = spec.jsonObjects.get(flag);
    if (jsonObjectField !== undefined) {
      input[jsonObjectField] = parseJsonObjectFlag(value, usageMessage);
      index += 1;
      continue;
    }

    const jsonValueField = spec.jsonValues.get(flag);
    if (jsonValueField !== undefined) {
      input[jsonValueField] = parseJsonValueFlag(value, usageMessage);
      index += 1;
      continue;
    }

    const keyValueField = spec.keyValues.get(flag);
    if (keyValueField !== undefined) {
      input[keyValueField] = {
        ...readStringRecord(input[keyValueField]),
        ...parseKeyValueFlag(value, usageMessage),
      };
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }

  return { source: "inline", value: JSON.stringify(input) };
}

function parseJsonValueFlag(value: string, usageMessage: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliUsageError(usageMessage);
  }
}

function parseKeyValueFlag(value: string, usageMessage: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new CliUsageError(usageMessage);
  }
  return { [value.slice(0, separator)]: value.slice(separator + 1) };
}

function readStringRecord(value: unknown): Record<string, string> {
  return isStringRecord(value) ? value : {};
}

type TypedOptionSpec = {
  readonly arrays: ReadonlyMap<string, string>;
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
  readonly booleans: ReadonlyMap<string, string>;
  readonly enums?: ReadonlyMap<string, ReadonlySet<string>>;
};

function parseTypedOptions(
  args: readonly string[],
  spec: TypedOptionSpec,
  usageMessage: string,
): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  if (args[0] === "--json") {
    return parseJsonArgument(args);
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      throw new CliUsageError(usageMessage);
    }

    const booleanField = spec.booleans.get(flag);
    if (booleanField !== undefined) {
      input[booleanField] = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(usageMessage);
    }

    const arrayField = spec.arrays.get(flag);
    if (arrayField !== undefined) {
      const values =
        arrayField === "attendees"
          ? parseCommaSeparatedValues(value).map((email) => ({ email }))
          : parseCommaSeparatedValues(value);
      input[arrayField] = [...readStringArrayOrRecordArray(input[arrayField]), ...values];
      index += 1;
      continue;
    }

    const stringField = spec.strings.get(flag);
    if (stringField !== undefined) {
      const allowedValues = spec.enums?.get(flag);
      if (allowedValues !== undefined && !allowedValues.has(value)) {
        throw new CliUsageError(usageMessage);
      }
      input[stringField] = value;
      index += 1;
      continue;
    }

    const numberField = spec.numbers.get(flag);
    if (numberField !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new CliUsageError(usageMessage);
      }
      input[numberField] = parsed;
      index += 1;
      continue;
    }

    throw new CliUsageError(usageMessage);
  }

  return { source: "inline", value: JSON.stringify(input) };
}

function readStringArrayOrRecordArray(value: unknown): Array<string | Record<string, string>> {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: Array<string | Record<string, string>> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      entries.push(entry);
      continue;
    }
    if (isStringRecord(entry)) {
      entries.push(entry);
      continue;
    }
    return [];
  }
  return entries;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function parseAuthTokenCommand(
  args: readonly string[],
  commandName: "helix auth token" | "helix login",
  printExport = false,
): HelixCommand {
  const flags = parseFlags(args, new Set(["--client-id", "--client-secret", "--scope"]));
  const clientId = flags.get("--client-id");
  const clientSecret = flags.get("--client-secret");
  const scope = flags.get("--scope");
  if (clientId === undefined || clientSecret === undefined) {
    throw new CliUsageError(
      `Usage: ${commandName} --client-id <id> --client-secret <secret> [--scope <scopes>]`,
    );
  }
  return {
    kind: "auth-token",
    clientId,
    clientSecret,
    ...(printExport ? { printExport } : {}),
    ...(scope === undefined ? {} : { scope }),
  };
}

function parseFlags(args: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !allowed.has(flag) || value.startsWith("--")) {
      throw new CliUsageError("Invalid command flags.");
    }
    flags.set(flag, value);
  }
  return flags;
}

function parseJsonArgument(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }

  const [flag, value, ...rest] = args;
  if (flag !== "--json" || rest.length > 0) {
    throw new CliUsageError("Usage: helix tool call <id> [--json [JSON]]");
  }

  if (value === undefined) {
    return { source: "stdin" };
  }

  return { source: "inline", value };
}

export const usage = `Usage:
  helix tool list [--source <api|openapi|mcp>]
  helix tool describe <id>
  helix tool call <id> [--transport <rest|mcp>] [--json [JSON]]
  helix search <query>
  helix search --query <text> [--type <mail|chat|docs|drive|calendar>] [--limit <number>] [--json [JSON]]
  helix mail send [--to <email>] [--cc <email>] [--bcc <email>] [--from <email>] [--subject <text>] [--body <text>] [--html <html>] [--json [JSON]]
  helix mail reply [--thread-id <id>] [--message-id <id>] [--body <text>] [--html <html>] [--cc <email>] [--bcc <email>] [--json [JSON]]
  helix mail list [--mailbox <name>] [--label <label>] [--limit <number>] [--cursor <cursor>] [--json [JSON]]
  helix mail search [--query <text>] [--mailbox <name>] [--label <label>] [--limit <number>] [--cursor <cursor>] [--json [JSON]]
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
  helix chat send [--room-id <id>] [--body <text>] [--text <text>] [--json [JSON]]
  helix chat react [--json [JSON]]
  helix chat edit [--json [JSON]]
  helix chat delete [--json [JSON]]
  helix chat create-room [--name <name>] [--subject <text>] [--description <text>] [--topic <text>] [--member <actor-id>] [--kind <chat_room|chat_dm>] [--private] [--json [JSON]]
  helix chat invite [--json [JSON]]
  helix chat search [--query <text>] [--room-id <id>] [--limit <number>] [--cursor <cursor>] [--json [JSON]]
  helix chat messages [--room-id <id>] [--before <iso>] [--limit <number>] [--json [JSON]]
  helix drive upload <path> [--folder <folder-id>] [--name <name>] [--mime-type <type>] [--byte-size <number>] [--sha256 <hex>] [--json [JSON]]
  helix drive finalize [--json [JSON]]
  helix drive list [--folder <folder-id>] [--limit <number>] [--include-trashed] [--json [JSON]]
  helix drive share [--json [JSON]]
  helix drive move [--json [JSON]]
  helix drive trash [--json [JSON]]
  helix drive restore [--json [JSON]]
  helix drive delete [--json [JSON]]
  helix drive search [--query <text>] [--folder <folder-id>] [--limit <number>] [--json [JSON]]
  helix docs create [--title <text>] [--initial-markdown <markdown>] [--folder <folder-id>] [--metadata <json-object>] [--json [JSON]]
  helix docs get [--doc-id <id>] [--json [JSON]]
  helix docs list [--query <text>] [--limit <number>] [--json [JSON]]
  helix docs update-title [--doc-id <id>] [--title <text>] [--json [JSON]]
  helix docs export [--doc-id <id>] [--format <markdown|pdf|docx>] [--include-comments] [--filename <name>] [--json [JSON]]
  helix docs comment-create [--doc-id <id>] [--body <text>] [--anchor <json-object>] [--metadata <json-object>] [--json [JSON]]
  helix calendar event-create [--calendar-id <id>] [--title <text>] [--description <text>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--location <text>] [--attendee <email>] [--all-day] [--json [JSON]]
  helix calendar event-update [--event-id <id>] [--calendar-id <id>] [--title <text>] [--description <text>] [--start <iso>] [--end <iso>] [--timezone <tz>] [--location <text>] [--attendee <email>] [--all-day] [--json [JSON]]
  helix calendar event-delete [--event-id <id>] [--send-cancellation] [--json [JSON]]
  helix calendar event-respond [--event-id <id>] [--attendee-email <email>] [--rsvp-token <token>] [--response <accepted|declined|tentative>] [--json [JSON]]
  helix calendar event-list [--calendar-id <id>] [--start <iso>] [--end <iso>] [--limit <number>] [--json [JSON]]
  helix calendar find-time [--attendee <email>] [--attendee-email <email>] [--attendee-actor-id <id>] [--duration-minutes <number>] [--step-minutes <number>] [--limit <number>] [--start <iso>] [--end <iso>] [--json [JSON]]
  helix webhook outbound create [--name <name>] [--url <url>] [--event-subject <subject>] [--secret-ref <ref>] [--header <name=value>] [--headers <json-object>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook outbound update [--id <id>] [--name <name>] [--url <url>] [--event-subject <subject>] [--secret-ref <ref>] [--header <name=value>] [--headers <json-object>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook outbound delete [--id <id>] [--json [JSON]]
  helix webhook outbound list [--json [JSON]]
  helix webhook outbound test [--id <id>] [--subject <subject>] [--payload <json>] [--json [JSON]]
  helix webhook outbound replay [--delivery-id <id>] [--id <id>] [--json [JSON]]
  helix webhook inbound create [--name <name>] [--slug <slug>] [--source <source>] [--secret-ref <ref>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook inbound update [--id <id>] [--name <name>] [--slug <slug>] [--source <source>] [--secret-ref <ref>] [--metadata <json-object>] [--enabled] [--disabled] [--json [JSON]]
  helix webhook inbound delete [--id <id>] [--json [JSON]]
  helix webhook inbound rotate-secret [--id <id>] [--json [JSON]]
  helix webhook inbound list [--json [JSON]]
  helix webhook delivery get [--id <id>] [--json [JSON]]
  helix webhook delivery list [--direction <outbound|inbound>] [--status <pending|in_progress|delivered|failed|abandoned>] [--limit <number>] [--json [JSON]]
  helix admin app-passwords list [--actor-id <id>] [--include-revoked] [--json [JSON]]
  helix admin app-passwords create [--actor-id <id>] [--label <label>] [--scope <scope>] [--expires-at <iso>] [--json [JSON]]
  helix admin app-passwords revoke [--password-id <id>] [--json [JSON]]
  helix admin agent-credentials list [--actor-id <id>] [--include-revoked] [--json [JSON]]
  helix admin agent-credentials create [--actor-id <id>] [--scope <scope>] [--expires-at <iso>] [--json [JSON]]
  helix admin agent-credentials revoke [--client-id <id>] [--json [JSON]]
  helix admin users list [--query <text>] [--type <user|agent|service_account|system>] [--include-disabled] [--limit <number>] [--cursor <cursor>]
  helix admin audit list [--actor-id <id>] [--object-id <id>] [--object-type <type>] [--verb <verb>] [--limit <number>] [--cursor <cursor>]
  helix admin storage test
  helix admin storage-migrations list [--target <byo|helix-default>] [--status <queued|running|succeeded|succeeded_with_errors|failed|dry_run>] [--limit <number>] [--cursor <cursor>]
  helix admin storage-migrations request --target <byo|helix-default> [--dry-run | --live --confirm LIVE] [--source-storage <json-object>] [--target-storage <json-object>]
  helix admin storage-migrations get <migration-id>
  helix admin storage-migrations cutover <migration-id> --confirm CUTOVER
  helix admin tenant-exports queue <slug> [--include-object-bytes | --metadata-only] [--presigned-url-expires-seconds <seconds>]
  helix admin tenant-exports list <slug> [--status <queued|running|succeeded|failed>] [--limit <number>] [--cursor <cursor>]
  helix admin tenant-exports status <slug> <job-id>
  helix admin tenant-exports download <slug> <job-id> --output <path> [--force]
  helix admin tenant-imports dry-run <slug> <archive-path>
  helix backup create
  helix restore --from <backup-id> [--encrypted]
  helix reindex --all
  helix action status <action-id>
  helix action approve <action-id>
  helix action cancel <action-id>
  helix tier set <personal|business|enterprise|sovereign>
  helix assistant chat [--json [JSON]]
  helix assistant new [--json [JSON]]
  helix assistant forget [--json [JSON]]
  helix assistant approve [--conversation-id <id>] [--pending-id <id>] [--classification <public|standard|confidential|restricted>] [--json [JSON]]
  helix assistant cancel [--conversation-id <id>] [--pending-id <id>] [--classification <public|standard|confidential|restricted>] [--json [JSON]]
  helix login --client-id <id> --client-secret <secret> [--scope <scopes>]
  helix logout
  helix auth token --client-id <id> --client-secret <secret> [--scope <scopes>]
  helix install list
  helix install plugin <id> [--json [JSON]]
  helix install enable <id> [--json [JSON]]
  helix install disable <id> [--json [JSON]]
  helix install uninstall <id> [--json [JSON]]
  helix plugin install <id>[@<version>] [--json [JSON]]
  helix plugin enable <id> [--json [JSON]]
  helix plugin disable <id> [--json [JSON]]
  helix plugin uninstall <id> [--json [JSON]]
  helix openapi get
  helix asyncapi get
  helix mcp serve
  helix mcp resources list
  helix mcp resources read <uri>
  helix completion <bash|zsh|fish>

Environment:
  HELIX_BASE_URL         Base URL for the Helix API
  HELIX_ACCESS_TOKEN     Optional bearer token for API requests
  HELIX_CREDENTIALS_FILE Override path for stored credentials (helix logout)`;
