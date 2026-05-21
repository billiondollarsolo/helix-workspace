import type { Actor, JsonObject } from "@helix/sdk-types";

export type AssistantSlashCommandName = string;

export interface AssistantSlashCommand {
  readonly name: AssistantSlashCommandName;
  readonly raw: string;
  readonly args: string;
  readonly argv: readonly string[];
}

export interface AssistantSlashCommandContext {
  readonly actor: Actor;
  readonly command: AssistantSlashCommand;
  readonly metadata?: JsonObject;
}

export interface AssistantSlashCommandHookResult {
  readonly instruction?: string;
  readonly searchQuery?: string;
  readonly toolIds?: readonly string[];
  readonly metadata?: JsonObject;
}

export type AssistantSlashCommandHook = (
  context: AssistantSlashCommandContext,
) =>
  | Promise<AssistantSlashCommandHookResult | undefined>
  | AssistantSlashCommandHookResult
  | undefined;

export class AssistantSlashCommandHooks {
  readonly #hooks = new Map<string, AssistantSlashCommandHook>();

  register(name: string, hook: AssistantSlashCommandHook): void {
    this.#hooks.set(normalizeCommandName(name), hook);
  }

  unregister(name: string): void {
    this.#hooks.delete(normalizeCommandName(name));
  }

  async resolve(
    context: AssistantSlashCommandContext,
  ): Promise<AssistantSlashCommandHookResult | undefined> {
    const hook = this.#hooks.get(normalizeCommandName(context.command.name));
    return hook === undefined
      ? resolveDefaultAssistantSlashCommand(context.command)
      : hook(context);
  }
}

export function parseAssistantSlashCommand(input: string): AssistantSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") {
    return null;
  }
  const [head, ...rest] = splitArgs(trimmed);
  if (head === undefined || head.length <= 1) {
    return null;
  }
  const args = trimmed.slice(head.length).trimStart();
  return {
    name: normalizeCommandName(head.slice(1)),
    raw: trimmed,
    args,
    argv: rest,
  };
}

export function resolveDefaultAssistantSlashCommand(
  command: AssistantSlashCommand,
): AssistantSlashCommandHookResult | undefined {
  const route = defaultSlashCommandRoutes[normalizeCommandName(command.name)];
  if (route === undefined) {
    return undefined;
  }
  const args = command.args.trim();
  return {
    instruction: route.instruction(args),
    searchQuery: args,
    toolIds: route.toolIds,
    metadata: {
      route: route.name,
      searchQuery: args,
      toolIds: [...route.toolIds],
    },
  };
}

function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

function splitArgs(input: string): readonly string[] {
  return (
    input.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => {
      if (
        (part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'"))
      ) {
        return part.slice(1, -1);
      }
      return part;
    }) ?? []
  );
}

interface DefaultAssistantSlashCommandRoute {
  readonly name: string;
  readonly toolIds: readonly string[];
  instruction(args: string): string;
}

const readContextToolIds = [
  "chat.search",
  "docs.get",
  "docs.export",
  "drive.list",
  "drive.search",
  "mail.search",
  "mail.thread.get",
] as const;

const defaultSlashCommandRoutes: Readonly<Record<string, DefaultAssistantSlashCommandRoute>> = {
  draft: {
    name: "draft",
    toolIds: readContextToolIds,
    instruction: (args) =>
      [
        "Draft content for the actor without sending or publishing it.",
        "Use read-only context tools when needed, then return editable draft text.",
        `Request: ${args}`,
      ].join("\n"),
  },
  summarize: {
    name: "summarize",
    toolIds: [...readContextToolIds, "calendar.event.list"],
    instruction: (args) =>
      [
        "Summarize the relevant actor-visible context for this request.",
        "Prefer concise bullets with citations when retrieved sources are available.",
        `Request: ${args}`,
      ].join("\n"),
  },
  find: {
    name: "find",
    toolIds: [
      "calendar.event.list",
      "chat.search",
      "docs.get",
      "docs.export",
      "drive.list",
      "drive.search",
      "mail.search",
    ],
    instruction: (args) =>
      [
        "Find actor-visible Helix content matching this request.",
        "Use search and list tools before answering; do not mutate content.",
        `Request: ${args}`,
      ].join("\n"),
  },
  schedule: {
    name: "schedule",
    toolIds: ["calendar.event.list", "calendar.find-time", "calendar.event.create"],
    instruction: (args) =>
      [
        "Help schedule this request with calendar tools.",
        "Check existing events or free/busy options first; create an event only when the request is specific enough.",
        `Request: ${args}`,
      ].join("\n"),
  },
};
