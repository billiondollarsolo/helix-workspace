import type { ToolDefinition } from "@helix/sdk-types";

export function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}
