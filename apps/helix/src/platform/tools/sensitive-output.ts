import type { JsonValue, ToolDefinition } from "@helix/sdk-types";

/** Stored in place of a one-time secret. */
export const REDACTED_TOOL_OUTPUT = "[redacted: shown once]";

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Removes one-time secrets from a tool's output before it is persisted.
 *
 * Tools that mint credentials list the output keys that hold secret material
 * in `sensitiveOutputKeys`. The live execute or approve response still carries
 * the secret. Every stored copy gets the redacted value instead: the
 * pending-action result, the idempotency replay cache, and anything read back
 * through `actions.get`.
 */
function redactSensitiveToolOutput(
  tool: Pick<ToolDefinition, "sensitiveOutputKeys"> | undefined,
  output: unknown,
): unknown {
  const keys = tool?.sensitiveOutputKeys ?? [];
  if (keys.length === 0 || typeof output !== "object" || output === null || Array.isArray(output)) {
    return output;
  }
  const redacted: Record<string, unknown> = { ...(output as Record<string, unknown>) };
  for (const key of keys) {
    if (redacted[key] !== undefined) redacted[key] = REDACTED_TOOL_OUTPUT;
  }
  return redacted;
}

/** The persistable JSON form of a tool output, with secrets redacted. */
export function persistedToolOutput(
  tool: Pick<ToolDefinition, "sensitiveOutputKeys"> | undefined,
  output: unknown,
): JsonValue {
  return toJsonValue(redactSensitiveToolOutput(tool, output));
}

/** Redacts the output of a successful invocation result before it is cached. */
export function redactToolInvokeResult<Result>(
  tool: Pick<ToolDefinition, "sensitiveOutputKeys"> | undefined,
  result: Result,
): Result {
  if (typeof result !== "object" || result === null || !("output" in result)) return result;
  const output = redactSensitiveToolOutput(tool, result.output);
  return output === result.output ? result : { ...result, output };
}
