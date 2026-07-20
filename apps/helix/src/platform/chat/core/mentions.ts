/**
 * Pure @mention parser (G5). No DB; resolve handles via the provided callback.
 *
 * Mentions match `@handle` tokens that are not part of an email address.
 * Special sentinels `@here` and `@channel` are returned as the literal strings
 * `"@here"` / `"@channel"` so callers can fan out without resolving members.
 */

const MENTION_RE = /(^|[^a-zA-Z0-9._%+-])@([a-zA-Z0-9._-]+)/gu;

export type MentionResolve = (handle: string) => string | null;

export function parseMentions(body: string, resolve: MentionResolve): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[2];
    if (handle === undefined) {
      continue;
    }
    const lower = handle.toLowerCase();
    if (lower === "here") {
      if (!seen.has("@here")) {
        seen.add("@here");
        found.push("@here");
      }
      continue;
    }
    if (lower === "channel") {
      if (!seen.has("@channel")) {
        seen.add("@channel");
        found.push("@channel");
      }
      continue;
    }
    const actorId = resolve(handle);
    if (actorId === null || seen.has(actorId)) {
      continue;
    }
    seen.add(actorId);
    found.push(actorId);
  }

  return found;
}

/**
 * Build a handle → actorId resolver from room members (displayName / email local-part).
 */
export function memberHandleResolver(
  members: readonly {
    readonly actorId: string;
    readonly displayName: string | null;
    readonly email: string | null;
  }[],
): MentionResolve {
  const byHandle = new Map<string, string>();
  for (const member of members) {
    if (member.displayName !== null) {
      const slug = member.displayName.trim().toLowerCase().replace(/\s+/gu, ".");
      if (slug.length > 0) {
        byHandle.set(slug, member.actorId);
      }
      const first = member.displayName.trim().split(/\s+/u)[0]?.toLowerCase();
      if (first !== undefined && first.length > 0 && !byHandle.has(first)) {
        byHandle.set(first, member.actorId);
      }
    }
    if (member.email !== null) {
      const local = member.email.split("@")[0]?.toLowerCase();
      if (local !== undefined && local.length > 0) {
        byHandle.set(local, member.actorId);
      }
    }
  }
  return (handle) => byHandle.get(handle.toLowerCase()) ?? null;
}
