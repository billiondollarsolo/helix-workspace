import { BadRequestError } from "../../api/api-error.js";
import type { AssistantVisibleTool } from "./types.js";

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

/**
 * Opt-in groups stay off by default so the default selection fits the 128-tool limit
 * OpenAI-compatible providers enforce (all groups for a fully scoped member exceed it).
 */
const optInToolGroups: ReadonlySet<ToolGroup> = new Set(["admin", "webhooks", "meet"]);

export function selectedToolGroups(groups?: readonly string[]): readonly ToolGroup[] {
  if (groups === undefined) return assistantToolGroupIds.filter((id) => !optInToolGroups.has(id));
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

const commonTools = new Set(["platform.ping"]);

export function filterToolGroups(
  tools: readonly AssistantVisibleTool[],
  groups?: readonly string[],
): readonly AssistantVisibleTool[] {
  const selected = selectedToolGroups(groups);
  return tools.filter(
    (tool) =>
      commonTools.has(tool.id) ||
      tool.id === "web.search" ||
      tool.id === "web.fetch" ||
      selected.includes(groupFor(tool.id)),
  );
}

export function assistantToolGroups(tools: readonly AssistantVisibleTool[]) {
  const defaults = selectedToolGroups();
  return {
    groups: assistantToolGroupIds.map((id) => ({
      id,
      label: labels[id],
      defaultEnabled: defaults.includes(id),
      count: tools.filter(
        (tool) =>
          !commonTools.has(tool.id) && !tool.id.startsWith("web.") && groupFor(tool.id) === id,
      ).length,
    })),
  };
}
