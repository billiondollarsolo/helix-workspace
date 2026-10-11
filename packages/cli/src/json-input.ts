import { CliUsageError } from "./cli-error.js";

type JsonOverrides = Readonly<Record<string, unknown>>;

/**
 * A tool call's JSON input. `--json` takes the JSON inline or, without a
 * value, from stdin. Commands with flags accept both: the JSON is the base and
 * each flag sets (and overrides) its field.
 */
export type JsonArgument =
  | { readonly source: "empty" }
  | { readonly source: "inline"; readonly value: string; readonly overrides?: JsonOverrides }
  | { readonly source: "stdin"; readonly overrides?: JsonOverrides };

/** `--json [JSON]` as a command's only arguments. */
export function parseJsonArgument(args: readonly string[]): JsonArgument {
  if (args.length === 0) {
    return { source: "empty" };
  }
  const [flag, value, ...rest] = args;
  if (flag !== "--json" || rest.length > 0) {
    throw new CliUsageError("Usage: helix tool call <id> [--json [JSON]]");
  }
  return value === undefined ? { source: "stdin" } : { source: "inline", value };
}

/**
 * Separates `--json [JSON]`, wherever it appears, from the command's flags. The
 * word after `--json` is its inline JSON unless it is another flag.
 */
export function splitJsonFlag(args: readonly string[]): {
  readonly base: JsonArgument;
  readonly flags: readonly string[];
} {
  const index = args.indexOf("--json");
  if (index === -1) return { base: { source: "empty" }, flags: args };
  const value = args[index + 1];
  const inline = value !== undefined && !value.startsWith("--");
  const flags = [...args.slice(0, index), ...args.slice(index + (inline ? 2 : 1))];
  if (flags.includes("--json")) throw new CliUsageError("Pass --json at most once.");
  return { base: inline ? { source: "inline", value } : { source: "stdin" }, flags };
}

/** The `--json` base with the flags' fields on top; flags alone become the whole input. */
export function withFlagOverrides(
  base: JsonArgument,
  overrides: Readonly<Record<string, unknown>>,
): JsonArgument {
  if (Object.keys(overrides).length === 0) return base;
  if (base.source === "empty") return { source: "inline", value: JSON.stringify(overrides) };
  return { ...base, overrides };
}

/** Applies flag overrides to the parsed `--json` input. */
export function mergeJsonOverrides(input: unknown, overrides: JsonOverrides | undefined): unknown {
  if (overrides === undefined) return input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CliUsageError(
      "--json must be a JSON object when combined with flags; each flag sets one of its fields.",
    );
  }
  return { ...(input as Record<string, unknown>), ...overrides };
}
