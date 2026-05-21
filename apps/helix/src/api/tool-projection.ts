import type { ToolDefinition } from "@helix/sdk-types";

export function projectToolListItem(tool: ToolDefinition) {
  return {
    id: tool.id,
    description: tool.description,
    permission: tool.permission,
    sideEffects: tool.sideEffects,
    confirmationRequired: tool.confirmationRequired ?? false,
    ...(tool.rateLimit === undefined ? {} : { rateLimit: tool.rateLimit }),
    ...(tool.estimatedCostUsdMicros === undefined
      ? {}
      : { estimatedCostUsdMicros: tool.estimatedCostUsdMicros }),
  };
}
