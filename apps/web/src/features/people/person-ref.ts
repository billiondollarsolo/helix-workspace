import type { PeopleDirectoryPerson } from "./api";

/**
 * A recipient picked by a person, never typed as an id.
 *
 * - `member`: an org member. `actorId` is set; use it for chat, sharing and invites.
 * - `group`: an admin group. `groupId` is set; `email` is set when the group has an address.
 * - `external`: a raw address or a personal contact outside the org. Only `email` identifies it.
 */
export interface PersonRef {
  readonly kind: "member" | "group" | "external";
  readonly displayName: string;
  readonly email: string | null;
  readonly actorId: string | null;
  readonly groupId: string | null;
  readonly title: string | null;
  readonly avatarDataUrl: string | null;
}

export interface PersonRefRules {
  readonly allowExternal?: boolean | undefined;
  readonly allowGroups?: boolean | undefined;
}

const emailPattern = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/u;
const namedAddressPattern = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/u;

export function isValidEmailAddress(value: string): boolean {
  return value.length <= 254 && emailPattern.test(value);
}

export function personRefFromDirectory(person: PeopleDirectoryPerson): PersonRef {
  return {
    kind: person.kind === "group" ? "group" : person.actorId === null ? "external" : "member",
    displayName: person.displayName,
    email: person.email,
    actorId: person.kind === "group" ? null : person.actorId,
    groupId: person.kind === "group" ? person.id : null,
    title: person.title,
    avatarDataUrl: person.avatarDataUrl,
  };
}

/** Accepts `ada@example.com` or `Ada Lovelace <ada@example.com>`; anything else stays as typed. */
export function externalPersonRef(text: string): PersonRef {
  const trimmed = text.trim();
  const named = namedAddressPattern.exec(trimmed);
  const email = (named?.[2] ?? trimmed).trim();
  const name = named?.[1]?.trim() ?? "";
  return {
    kind: "external",
    displayName: name.length > 0 ? name : email,
    email,
    actorId: null,
    groupId: null,
    title: null,
    avatarDataUrl: null,
  };
}

/** Splits pasted text such as `a@x.com, Bo <b@y.org>; c@z.io` into one ref per entry. */
export function parseAddressList(text: string): PersonRef[] {
  return text
    .split(/[,;\n\r\t]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(externalPersonRef);
}

export function isPersonRefValid(ref: PersonRef, rules: PersonRefRules = {}): boolean {
  if (ref.kind === "member") return ref.actorId !== null;
  if (ref.kind === "group") return rules.allowGroups === true && ref.groupId !== null;
  return rules.allowExternal === true && ref.email !== null && isValidEmailAddress(ref.email);
}

/** Stable identity used to de-duplicate chips and suggestions. */
export function personRefKey(ref: PersonRef): string {
  if (ref.actorId !== null) return `actor:${ref.actorId}`;
  if (ref.groupId !== null) return `group:${ref.groupId}`;
  return `email:${(ref.email ?? ref.displayName).toLowerCase()}`;
}

/** The full address shown on hover, e.g. `Ada Lovelace <ada@example.com>`. */
export function personRefAddress(ref: PersonRef): string {
  if (ref.email === null) return ref.displayName;
  return ref.displayName === ref.email ? ref.email : `${ref.displayName} <${ref.email}>`;
}
