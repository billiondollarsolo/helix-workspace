/** One failing input field, shaped like the HTTP validation envelope's `details.issues`. */
interface ToolInputIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Structured details attached to a tool invocation failure. */
export interface ToolInvokeErrorDetails {
  readonly issues: readonly ToolInputIssue[];
}

/**
 * Describes a tool input validation failure. Schema errors exposing zod's
 * `issues` shape yield `details.issues` and a message naming the first failing
 * field, e.g. `Invalid input for mail.send: to.0: Invalid email (and 1 more issue)`.
 */
export function toolInputFailure(
  toolId: string,
  error: unknown,
): { readonly message: string; readonly details?: ToolInvokeErrorDetails } {
  const issues = toolInputIssues(error);
  const [first] = issues ?? [];
  if (issues === undefined || first === undefined) {
    return {
      message: error instanceof Error ? error.message : "Tool input validation failed",
    };
  }
  const field = first.path.length === 0 ? "input" : first.path.join(".");
  const extra = issues.length - 1;
  const more = extra === 0 ? "" : ` (and ${String(extra)} more issue${extra === 1 ? "" : "s"})`;
  return {
    message: `Invalid input for ${toolId}: ${field}: ${first.message}${more}`,
    details: { issues },
  };
}

function toolInputIssues(error: unknown): readonly ToolInputIssue[] | undefined {
  const issues = (error as { readonly issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const normalized: ToolInputIssue[] = [];
  for (const issue of issues as readonly unknown[]) {
    const { path, message } = (issue ?? {}) as {
      readonly path?: unknown;
      readonly message?: unknown;
    };
    if (typeof message !== "string") return undefined;
    normalized.push({
      path: Array.isArray(path)
        ? path.filter(
            (part): part is string | number => typeof part === "string" || typeof part === "number",
          )
        : [],
      message,
    });
  }
  return normalized;
}
