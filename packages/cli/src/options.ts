import type { HelixCliEnv } from "./client.js";
import { EXIT_CODES, exitCodeForError, HttpError, NetworkError, toNetworkError } from "./http.js";
import { CliUsageError } from "./parser.js";

const DEFAULT_TIMEOUT_SECONDS = 120;

export interface GlobalOptions {
  readonly timeoutMs: number;
  readonly idempotencyKey?: string;
  readonly output: "text" | "json";
  /** Set when `--help`/`-h` was passed: the positional words before it. */
  readonly help?: readonly string[];
}

interface Writer {
  write(chunk: string): unknown;
}

/**
 * Removes the global flags (`--timeout`, `--idempotency-key`, `--output`,
 * `--help`) from anywhere in the argument list. `helix restore` keeps its own
 * `--idempotency-key` flag, which is part of the restore request body.
 */
export function extractGlobalOptions(
  args: readonly string[],
  env: HelixCliEnv,
): { readonly args: readonly string[]; readonly options: GlobalOptions } {
  const rest: string[] = [];
  let timeoutSeconds = parseTimeout(env.HELIX_TIMEOUT, "HELIX_TIMEOUT");
  let idempotencyKey: string | undefined;
  let output: GlobalOptions["output"] = "text";
  let help: string[] | undefined;
  const ownsIdempotencyKey = args[0] === "restore";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const value = args[index + 1];
    if (arg === "--timeout") {
      timeoutSeconds = parseTimeout(value ?? "", "--timeout");
      index += 1;
    } else if (arg === "--idempotency-key" && !ownsIdempotencyKey) {
      if (value === undefined || !/^[\x21-\x7e]{8,200}$/u.test(value)) {
        throw new CliUsageError(
          "--idempotency-key needs 8-200 printable ASCII characters without spaces.",
        );
      }
      idempotencyKey = value;
      index += 1;
    } else if (arg === "--output") {
      if (value !== "text" && value !== "json") {
        throw new CliUsageError("--output must be text or json.");
      }
      output = value;
      index += 1;
    } else if ((arg === "--help" || arg === "-h") && help === undefined) {
      help = rest.filter((word) => !word.startsWith("-"));
    } else {
      rest.push(arg);
    }
  }

  return {
    args: rest,
    options: {
      timeoutMs: (timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      output,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(help === undefined ? {} : { help }),
    },
  };
}

function parseTimeout(value: string | undefined, label: string): number | undefined {
  if (value === undefined || (label === "HELIX_TIMEOUT" && value.trim().length === 0)) {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new CliUsageError(`${label} must be a number of seconds between 0 and 86400.`);
  }
  return seconds;
}

/** Detects `--output json` before full option parsing so early errors use JSON too. */
export function wantsJsonOutput(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "--output" && args[index + 1] === "json");
}

/** Writes a failure to stderr (text or `{"error":{...}}`) and returns its exit code. */
export function reportError(
  stderr: Writer,
  output: GlobalOptions["output"],
  error: unknown,
  usageText: string,
): number {
  const exitCode = exitCodeForError(error);
  const failure = exitCode === EXIT_CODES.network ? toNetworkError(error) : error;
  if (output === "json") {
    stderr.write(`${JSON.stringify({ error: errorObject(failure) })}\n`);
    return exitCode;
  }
  if (failure instanceof HttpError) {
    const body = failure.body.trim().length === 0 ? "" : ` ${failure.body.trim()}`;
    stderr.write(`${failure.message}${body}\n`);
  } else {
    stderr.write(`${failure instanceof Error ? failure.message : "Unknown CLI error"}\n`);
  }
  if (failure instanceof CliUsageError) stderr.write(`${usageText}\n`);
  return exitCode;
}

function errorObject(error: unknown): Record<string, unknown> {
  if (error instanceof HttpError) {
    const envelope = parseEnvelope(error.body);
    return {
      status: error.status,
      ...(envelope ?? {
        code: `http_${String(error.status)}`,
        message: error.body.trim().length > 0 ? error.body.trim() : error.message,
      }),
    };
  }
  if (error instanceof CliUsageError) return { code: "usage_error", message: error.message };
  if (error instanceof NetworkError) {
    return { code: error.timedOut ? "timeout" : "network_error", message: error.message };
  }
  return {
    code: "cli_error",
    message: error instanceof Error ? error.message : "Unknown CLI error",
  };
}

function parseEnvelope(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const inner = (parsed as { readonly error: unknown }).error;
      if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The pending action id from a `{status:"pending_confirmation", pending:{id}}` body. */
export function pendingActionId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { readonly status?: unknown; readonly pending?: unknown };
  if (record.status !== "pending_confirmation") return undefined;
  const pending = record.pending as { readonly id?: unknown } | undefined;
  return typeof pending?.id === "string" ? pending.id : "";
}

/**
 * Reports a 202 pending confirmation on stderr and returns exit code 6.
 * `resume` describes what to run after approval when it is not just waiting.
 */
export function reportPending(
  stderr: Writer,
  output: GlobalOptions["output"],
  actionId: string,
  resume?: string,
): number {
  const approve = `helix action approve ${actionId.length > 0 ? actionId : "<action-id>"}`;
  const message = `Action ${actionId.length > 0 ? `${actionId} ` : ""}awaits approval. Approve it with: ${approve}${resume === undefined ? "" : `; then ${resume}`}`;
  if (output === "json") {
    stderr.write(
      `${JSON.stringify({
        error: {
          code: "pending_confirmation",
          message,
          actionId,
          approveCommand: approve,
          ...(resume === undefined ? {} : { resume }),
        },
      })}\n`,
    );
  } else {
    stderr.write(`${message}\n`);
  }
  return EXIT_CODES.pendingConfirmation;
}
