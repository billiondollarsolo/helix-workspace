import { ApiError, BadRequestError } from "../../api/api-error.js";
import type { AssistantVisibleTool } from "./types.js";

/** OpenAI-compatible providers reject requests that declare more native tools. */
export const assistantToolLimit = 128;

export const assistantToolGroupIds = [
  "mail",
  "chat",
  "drive",
  "calendar",
  "meet",
  "notifications",
  "admin",
  "webhooks",
  "other",
] as const;
type ToolGroup = (typeof assistantToolGroupIds)[number];
const labels: Record<ToolGroup, string> = {
  mail: "Mail",
  chat: "Chat",
  drive: "Drive",
  calendar: "Calendar",
  meet: "Meet",
  notifications: "Notifications",
  admin: "Administration",
  webhooks: "Webhooks",
  other: "Workspace search and other tools",
};

/** Opt-in groups join a turn only when the user selects them. */
const optInToolGroups: ReadonlySet<ToolGroup> = new Set(["admin", "webhooks", "meet"]);
/** Default groups in fill order when the prompt names none of them. */
const defaultGroupPriority: readonly ToolGroup[] = [
  "mail",
  "calendar",
  "drive",
  "chat",
  "other",
  "notifications",
];
const promptSignals: Partial<Record<ToolGroup, RegExp>> = {
  mail: /\b(?:e-?mails?|mail|inbox|drafts?|repl(?:y|ies)|labels?|unread|newsletters?|sender)\b/iu,
  calendar:
    /\b(?:calendars?|meetings?|events?|schedul\w*|availab\w*|agenda|invites?|appointments?|free time)\b/iu,
  drive: /\b(?:drive|files?|folders?|docs?|documents?|uploads?|pdfs?|spreadsheets?|storage)\b/iu,
  chat: /\b(?:chats?|spaces?|dms?|direct messages?|channels?|mentions?|conversations?)\b/iu,
  notifications: /\bnotifications?\b/iu,
  other: /\b(?:search|find|look up|tasks?|routines?|memory|remember)\b/iu,
};
/** Web tools a turn may need to replay from history stay within the limit. */
const historyReserve = ["web.search", "web.fetch"] as const;

/** Validate an explicit group choice; `undefined` keeps the budgeted default. */
export function explicitToolGroups(groups?: readonly string[]): readonly ToolGroup[] | undefined {
  if (groups === undefined) return undefined;
  if (
    groups.length > assistantToolGroupIds.length ||
    groups.some((id) => !assistantToolGroupIds.some((known) => known === id))
  )
    throw new BadRequestError("Choose valid Assistant tool groups.");
  return assistantToolGroupIds.filter((id) => groups.includes(id));
}

function groupFor(toolId: string): ToolGroup {
  if (/^(?:admin|agent|agents)\./u.test(toolId) || toolId.startsWith("app.passwords."))
    return "admin";
  if (/^webhooks?\./u.test(toolId)) return "webhooks";
  const namespace = toolId.split(".")[0];
  return assistantToolGroupIds.find((id) => id === namespace) ?? "other";
}

function isCommonTool(toolId: string): boolean {
  return toolId === "platform.ping" || toolId === "web.search" || toolId === "web.fetch";
}

/**
 * Pick the tools for one turn. An explicit selection is honored exactly and
 * rejected with the groups to turn off when it exceeds the provider limit. The
 * default selection never fails: it ranks the default groups by the prompt,
 * adds whole groups while they fit, then fills the rest read-only first.
 */
export function selectTurnTools(
  tools: readonly AssistantVisibleTool[],
  input: { readonly groups?: readonly string[] | undefined; readonly prompt?: string | undefined },
): readonly AssistantVisibleTool[] {
  const explicit = explicitToolGroups(input.groups);
  if (explicit !== undefined) {
    const selected = tools.filter(
      (tool) => isCommonTool(tool.id) || explicit.includes(groupFor(tool.id)),
    );
    if (selected.length > assistantToolLimit) throw assistantToolLimitError(selected);
    return selected;
  }
  const common = tools.filter((tool) => isCommonTool(tool.id));
  const reserve = historyReserve.filter((id) => !common.some((tool) => tool.id === id)).length;
  let budget = assistantToolLimit - common.length - reserve;
  const chosen = new Set(common.map((tool) => tool.id));
  for (const group of rankedDefaultGroups(input.prompt ?? "")) {
    const members = tools
      .filter((tool) => !chosen.has(tool.id) && groupFor(tool.id) === group)
      .sort((a, b) => Number(a.sideEffects !== "read") - Number(b.sideEffects !== "read"));
    const fitting = members.length <= budget ? members : members.slice(0, Math.max(budget, 0));
    for (const tool of fitting) chosen.add(tool.id);
    budget -= fitting.length;
    if (budget <= 0) break;
  }
  return tools.filter((tool) => chosen.has(tool.id));
}

function rankedDefaultGroups(prompt: string): readonly ToolGroup[] {
  const mentioned = defaultGroupPriority.filter((group) => promptSignals[group]?.test(prompt));
  return [...mentioned, ...defaultGroupPriority.filter((group) => !mentioned.includes(group))];
}

/** Actionable over-limit error: the selected groups, largest first, to turn off. */
export function assistantToolLimitError(selected: readonly AssistantVisibleTool[]): ApiError {
  const counts = new Map<ToolGroup, number>();
  for (const tool of selected) {
    if (isCommonTool(tool.id)) continue;
    const group = groupFor(tool.id);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const groups = [...counts]
    .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
    .map(([id, count]) => ({ id, label: labels[id], count }));
  return new ApiError(
    "assistant_tool_limit_exceeded",
    `The selected tool groups include ${String(selected.length)} tools; the limit is ${String(assistantToolLimit)}. Turn off ${groups[0]?.label ?? "a tool group"} or another group and try again.`,
    {
      details: {
        limit: assistantToolLimit,
        selected: selected.length,
        excess: selected.length - assistantToolLimit,
        groups,
      },
    },
  );
}

export function assistantToolGroups(tools: readonly AssistantVisibleTool[]) {
  return {
    limit: assistantToolLimit,
    groups: assistantToolGroupIds.map((id) => ({
      id,
      label: labels[id],
      defaultEnabled: !optInToolGroups.has(id),
      count: tools.filter((tool) => !isCommonTool(tool.id) && groupFor(tool.id) === id).length,
    })),
  };
}
