/** Pure helpers shared by the two credential-issuing sections
 *  (`app-passwords-management.tsx` and `agent-credentials-management.tsx`).
 *
 *  Both sections issue a scoped, optionally-expiring secret against an actor
 *  picked from the directory, so the scope parsing, the expiry normalisation,
 *  and the field shell they draw were byte-identical copies. One copy means a
 *  fix to either lands on both instead of on whichever file was open. */

/* The actor picker sits next to `Input` fields in the same form and there is no
   shared Select primitive to inherit that shell from. */
/* The console has no Select primitive yet — mirror `Input` so the actor picker
   does not read as a control from a different family than the fields beside it. */
export const SELECT_CLASS =
  "h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50";

export const invalidExpiresAt = Symbol("invalidExpiresAt");

export type ActorStatus = "loading" | "error" | "empty" | "truncated" | "ready";

export function actorStatusOf(input: {
  readonly actorCount: number;
  readonly hasMore: boolean;
  readonly isError: boolean;
  readonly isPending: boolean;
}): ActorStatus {
  if (input.isError) {
    return "error";
  }
  if (input.isPending) {
    return "loading";
  }
  if (input.actorCount === 0) {
    return "empty";
  }
  return input.hasMore ? "truncated" : "ready";
}

export function parseScopes(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export function toggleScope(value: string, scope: string, selected: boolean): string {
  const scopes = parseScopes(value).filter((candidate) => candidate !== scope);
  return (selected ? scopes : [...scopes, scope]).join(" ");
}

export function normalizeExpiresAt(value: string): string | null | typeof invalidExpiresAt {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? invalidExpiresAt : date.toISOString();
}

/* One formatter for the whole module: `Intl.DateTimeFormat` resolves its
   locale data on construction, which is the expensive half, and every call site
   asks for the same medium/short pair. */
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return dateTimeFormat.format(new Date(value));
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
