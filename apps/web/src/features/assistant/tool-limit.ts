/* The provider caps how many tools one request may declare. When an explicit
   tool-group choice goes over it, the server answers with
   `assistant_tool_limit_exceeded` and the groups to turn off, largest first. */

const ASSISTANT_TOOL_LIMIT_CODE = "assistant_tool_limit_exceeded";

export interface AssistantToolLimit {
  readonly limit: number;
  readonly selected: number;
  readonly excess: number;
  /** Selected groups with their tool counts, largest first. */
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
  }[];
}

/** An Assistant request failure that carries the server's error code. */
export class AssistantRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly toolLimit: AssistantToolLimit | undefined,
  ) {
    super(message);
    this.name = "AssistantRequestError";
  }
}

/** Builds the error for a failed response or SSE `error` frame. */
export function assistantRequestError(output: unknown, fallback: string): AssistantRequestError {
  const envelope = isRecord(output) && isRecord(output.error) ? output.error : output;
  const message =
    isRecord(output) && typeof output.error === "string"
      ? output.error
      : isRecord(envelope) && typeof envelope.message === "string"
        ? envelope.message
        : fallback;
  const code = isRecord(envelope) && typeof envelope.code === "string" ? envelope.code : undefined;
  const toolLimit =
    code === ASSISTANT_TOOL_LIMIT_CODE && isRecord(envelope)
      ? toolLimitFromDetails(envelope.details)
      : undefined;
  return new AssistantRequestError(message, code, toolLimit);
}

function toolLimitFromDetails(details: unknown): AssistantToolLimit | undefined {
  if (
    !isRecord(details) ||
    typeof details.limit !== "number" ||
    typeof details.selected !== "number" ||
    !Array.isArray(details.groups)
  ) {
    return undefined;
  }
  const groups = details.groups.flatMap((group: unknown) =>
    isRecord(group) &&
    typeof group.id === "string" &&
    typeof group.label === "string" &&
    typeof group.count === "number"
      ? [{ id: group.id, label: group.label, count: group.count }]
      : [],
  );
  return {
    limit: details.limit,
    selected: details.selected,
    excess: typeof details.excess === "number" ? details.excess : details.selected - details.limit,
    groups,
  };
}

/** "Too many tool groups are on (143 of 128 tools)." */
export function toolLimitSummary(limit: AssistantToolLimit): string {
  return `Too many tool groups are on (${String(limit.selected)} of ${String(limit.limit)} tools).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
