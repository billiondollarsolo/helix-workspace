import type { JsonObject } from "@helix/sdk-types";

/** Normalize a mention token for comparison (lowercase, strip leading @). */
export function normalizeMentionToken(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

/** Extract @mention tokens from free text (unicode letters/numbers). */
export function mentionTokensFromText(value: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@([\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?)/gu)) {
    const token = normalizeMentionToken(match[2] ?? "");
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** Extract mention tokens from comment metadata.mentionsText array. */
export function mentionTokensFromMetadata(metadata: JsonObject): readonly string[] {
  const mentionsText = metadata.mentionsText;
  if (!Array.isArray(mentionsText)) {
    return [];
  }
  const tokens = new Set<string>();
  for (const value of mentionsText) {
    if (typeof value !== "string") {
      continue;
    }
    const token = normalizeMentionToken(value);
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** Union of metadata + body mention tokens. */
export function mentionTokensForComment(metadata: JsonObject, body: string): readonly string[] {
  const tokens = new Set<string>();
  for (const token of mentionTokensFromMetadata(metadata)) {
    tokens.add(token);
  }
  for (const token of mentionTokensFromText(body)) {
    tokens.add(token);
  }
  return [...tokens];
}

/** Alias used by plan/tests — parse @mentions from body text. */
export function parseMentions(body: string): readonly string[] {
  return mentionTokensFromText(body);
}

export function actorMentionAliases(actor: {
  readonly display_name: string;
  readonly email: string | null;
}): ReadonlySet<string> {
  const aliases = new Set<string>();
  const email = actor.email?.trim().toLowerCase();
  if (email !== undefined && email.length > 0) {
    aliases.add(email);
    aliases.add(email.split("@")[0] ?? email);
  }
  const displayName = actor.display_name.trim().toLowerCase();
  if (displayName.length > 0) {
    aliases.add(displayName);
    aliases.add(displayName.replace(/[^a-z0-9]+/gu, ""));
    const firstName = displayName.split(/\s+/u)[0];
    if (firstName !== undefined) {
      aliases.add(firstName);
    }
  }
  return aliases;
}

export function mentionedActorIds(input: {
  readonly actors: readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  readonly authorActorId: string;
  readonly tokens: readonly string[];
}): readonly string[] {
  const tokenSet = new Set(input.tokens.map(normalizeMentionToken));
  const ids: string[] = [];
  for (const actor of input.actors) {
    if (actor.id === input.authorActorId) {
      continue;
    }
    const aliases = actorMentionAliases(actor);
    if ([...tokenSet].some((token) => aliases.has(token))) {
      ids.push(actor.id);
    }
  }
  return ids;
}
