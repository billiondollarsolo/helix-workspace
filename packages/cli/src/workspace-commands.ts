/**
 * Flag wrappers for mail labels and scheduled sends, contacts, personal account
 * preferences and app passwords, and the chat Home/Mentions views. Creating an
 * app password needs a signed-in web session, so the CLI cannot mint one; use
 * Settings → Security.
 */

interface FlagSpec {
  readonly strings?: Readonly<Record<string, string>>;
  readonly numbers?: Readonly<Record<string, string>>;
  readonly booleans?: Readonly<Record<string, string>>;
  readonly required?: readonly string[];
}

interface CommandSpec {
  readonly toolId: string;
  readonly usage: string;
  readonly flags: FlagSpec;
}

const mailbox = { "--mailbox-actor-id": "mailboxActorId" } as const;
const contactFields = {
  "--given-name": "givenName",
  "--family-name": "familyName",
  "--company": "company",
  "--job-title": "jobTitle",
  "--birthday": "birthday",
  "--notes": "notes",
} as const;
const contactFieldUsage =
  "[--given-name <name>] [--family-name <name>] [--company <name>] [--job-title <title>] [--birthday <YYYY-MM-DD>] [--notes <text>]";
/** Commands whose input holds lists (contact ids, emails) take `--json`. */
const jsonOnly = (spec: {
  readonly toolId: string;
  readonly action: string;
  readonly shape: string;
}): CommandSpec => ({
  toolId: spec.toolId,
  usage: `helix contacts ${spec.action} --json '${spec.shape}'`,
  flags: {},
});

const COMMANDS: Readonly<Record<string, Readonly<Record<string, CommandSpec>>>> = {
  mail: {
    labels: {
      toolId: "mail.labels.list",
      usage: "helix mail labels [--mailbox-actor-id <id>] [--json [JSON]]",
      flags: { strings: mailbox },
    },
    "label-create": {
      toolId: "mail.label.create",
      usage:
        "helix mail label-create --name <name> [--color <palette-name>] [--parent-id <id>] [--mailbox-actor-id <id>] [--json [JSON]]",
      flags: {
        strings: { "--name": "name", "--color": "color", "--parent-id": "parentId", ...mailbox },
        required: ["name"],
      },
    },
    "label-update": {
      toolId: "mail.label.update",
      usage:
        "helix mail label-update --id <id> [--name <name>] [--color <palette-name>] [--parent-id <id>] [--mailbox-actor-id <id>] [--json [JSON]]",
      flags: {
        strings: {
          "--id": "id",
          "--name": "name",
          "--color": "color",
          "--parent-id": "parentId",
          ...mailbox,
        },
        required: ["id"],
      },
    },
    "label-delete": {
      toolId: "mail.label.delete",
      usage: "helix mail label-delete --id <id> [--mailbox-actor-id <id>] [--json [JSON]]",
      flags: { strings: { "--id": "id", ...mailbox }, required: ["id"] },
    },
    scheduled: {
      toolId: "mail.scheduled.list",
      usage: "helix mail scheduled [--limit <number>] [--offset <number>] [--json [JSON]]",
      flags: { numbers: { "--limit": "limit", "--offset": "offset" } },
    },
    "scheduled-reschedule": {
      toolId: "mail.scheduled.reschedule",
      usage: "helix mail scheduled-reschedule --outbound-id <id> --send-at <iso> [--json [JSON]]",
      flags: {
        strings: { "--outbound-id": "outboundId", "--send-at": "sendAt" },
        required: ["outboundId", "sendAt"],
      },
    },
    "scheduled-cancel": {
      toolId: "mail.scheduled.cancel",
      usage: "helix mail scheduled-cancel --outbound-id <id> [--json [JSON]]",
      flags: { strings: { "--outbound-id": "outboundId" }, required: ["outboundId"] },
    },
  },
  contacts: {
    list: {
      toolId: "contacts.list",
      usage:
        "helix contacts list [--view <contacts|trash>] [--label <label>] [--query <text>] [--limit <number>] [--offset <number>] [--json [JSON]]",
      flags: {
        strings: { "--view": "view", "--label": "label", "--query": "query" },
        numbers: { "--limit": "limit", "--offset": "offset" },
      },
    },
    get: {
      toolId: "contacts.get",
      usage: "helix contacts get --id <id> [--json [JSON]]",
      flags: { strings: { "--id": "id" }, required: ["id"] },
    },
    create: {
      toolId: "contacts.create",
      usage: `helix contacts create ${contactFieldUsage} [--json [JSON]]`,
      flags: { strings: contactFields },
    },
    update: {
      toolId: "contacts.update",
      usage: `helix contacts update --id <id> ${contactFieldUsage} [--json [JSON]]`,
      flags: { strings: { "--id": "id", ...contactFields }, required: ["id"] },
    },
    trash: jsonOnly({ toolId: "contacts.trash", action: "trash", shape: '{"ids":["<id>"]}' }),
    restore: jsonOnly({ toolId: "contacts.restore", action: "restore", shape: '{"ids":["<id>"]}' }),
    purge: jsonOnly({ toolId: "contacts.purge", action: "purge", shape: '{"ids":["<id>"]}' }),
    duplicates: {
      toolId: "contacts.duplicates.list",
      usage: "helix contacts duplicates [--json [JSON]]",
      flags: {},
    },
    merge: jsonOnly({
      toolId: "contacts.merge",
      action: "merge",
      shape: '{"targetId":"<id>","sourceIds":["<id>"]}',
    }),
    import: jsonOnly({
      toolId: "contacts.import",
      action: "import",
      shape: '{"format":"vcard|csv","content":"…","dryRun":true}',
    }),
    export: {
      toolId: "contacts.export",
      usage: "helix contacts export [--label <label>] [--json [JSON]]",
      flags: { strings: { "--label": "label" } },
    },
    labels: {
      toolId: "contacts.labels.list",
      usage: "helix contacts labels [--json [JSON]]",
      flags: {},
    },
    "label-create": {
      toolId: "contacts.label.create",
      usage: "helix contacts label-create --name <name> [--json [JSON]]",
      flags: { strings: { "--name": "name" }, required: ["name"] },
    },
    "label-rename": {
      toolId: "contacts.label.rename",
      usage: "helix contacts label-rename --name <name> --new-name <name> [--json [JSON]]",
      flags: {
        strings: { "--name": "name", "--new-name": "newName" },
        required: ["name", "newName"],
      },
    },
    "label-delete": {
      toolId: "contacts.label.delete",
      usage: "helix contacts label-delete --name <name> [--json [JSON]]",
      flags: { strings: { "--name": "name" }, required: ["name"] },
    },
    "label-apply": jsonOnly({
      toolId: "contacts.label.apply",
      action: "label-apply",
      shape: '{"ids":["<id>"],"add":["<label>"],"remove":["<label>"]}',
    }),
    directory: {
      toolId: "contacts.directory.list",
      usage:
        "helix contacts directory [--query <text>] [--limit <number>] [--offset <number>] [--json [JSON]]",
      flags: {
        strings: { "--query": "query" },
        numbers: { "--limit": "limit", "--offset": "offset" },
      },
    },
  },
  account: {
    preferences: {
      toolId: "account.preferences.get",
      usage: "helix account preferences [--json [JSON]]",
      flags: {},
    },
    "preferences-set": {
      toolId: "account.preferences.set",
      usage:
        "helix account preferences-set [--language <tag>] [--time-zone <iana>] [--date-format <mdy|dmy|ymd>] [--time-format <12h|24h>] [--week-start <0-6>] [--json [JSON]]",
      flags: {
        strings: {
          "--language": "language",
          "--time-zone": "timeZone",
          "--date-format": "dateFormat",
          "--time-format": "timeFormat",
        },
        numbers: { "--week-start": "weekStart" },
      },
    },
    "app-passwords": {
      toolId: "app.passwords.list",
      usage: "helix account app-passwords [--include-revoked] [--json [JSON]]",
      flags: { booleans: { "--include-revoked": "includeRevoked" } },
    },
    "app-password-revoke": {
      toolId: "app.passwords.revoke",
      usage: "helix account app-password-revoke --password-id <id> [--json [JSON]]",
      flags: { strings: { "--password-id": "passwordId" }, required: ["passwordId"] },
    },
  },
  chat: {
    unread: {
      toolId: "chat.unread.list",
      usage: "helix chat unread [--json [JSON]]",
      flags: {},
    },
    mentions: {
      toolId: "chat.mentions.list",
      usage: "helix chat mentions [--limit <number>] [--before <iso>] [--json [JSON]]",
      flags: { strings: { "--before": "before" }, numbers: { "--limit": "limit" } },
    },
  },
};

/** Help lines for `usage.ts`, grouped by scope. */
export const workspaceCommandUsage: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    Object.entries(COMMANDS).map(([scope, commands]) => [
      scope,
      Object.values(commands).map((command) => command.usage),
    ]),
  );

/** Adds these commands' actions to the completion registry. */
export function withWorkspaceActions(
  actions: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  const merged = { ...actions };
  for (const [scope, commands] of Object.entries(COMMANDS)) {
    merged[scope] = [...(merged[scope] ?? []), ...Object.keys(commands)];
  }
  return merged;
}

/** Adds scopes that exist only as these commands (`account`) to the top-level list. */
export function withWorkspaceScopes(scopes: readonly string[]): readonly string[] {
  return [...scopes, ...Object.keys(COMMANDS).filter((scope) => !scopes.includes(scope))];
}

export type WorkspaceCommandParse =
  | {
      readonly toolId: string;
      /** Inline JSON input, or `null` when the caller passed `--json`. */
      readonly input: string | null;
    }
  | { readonly usage: string };

/** `undefined` when the scope/action pair is not one of these commands. */
export function parseWorkspaceCommand(
  scope: string,
  action: string | undefined,
  args: readonly string[],
): WorkspaceCommandParse | undefined {
  const spec = action === undefined ? undefined : COMMANDS[scope]?.[action];
  if (spec === undefined) return undefined;
  const usage = { usage: `Usage: ${spec.usage}` };
  if (args[0] === "--json") return { toolId: spec.toolId, input: null };
  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    const booleanKey = spec.flags.booleans?.[flag];
    if (booleanKey !== undefined) {
      input[booleanKey] = true;
      continue;
    }
    const value = args[index + 1];
    const stringKey = spec.flags.strings?.[flag];
    const numberKey = spec.flags.numbers?.[flag];
    if (value === undefined || value.startsWith("--")) return usage;
    if (stringKey !== undefined) input[stringKey] = value;
    else if (numberKey !== undefined && /^\d+$/u.test(value)) input[numberKey] = Number(value);
    else return usage;
    index += 1;
  }
  if ((spec.flags.required ?? []).some((key) => input[key] === undefined)) return usage;
  return { toolId: spec.toolId, input: JSON.stringify(input) };
}
