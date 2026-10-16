import { ApiError, BadRequestError } from "../../api/api-error.js";
import type { SearchEngine } from "../search/types.js";

export type MailBodyMatches = ReadonlyMap<string, readonly string[]>;
// shortcut: cap broad terms at 10,000 candidates; add paged index/SQL joins for larger searches.
export const MAIL_SEARCH_MAX_MATCHES = 10_000;

/** The index selects candidates; mailbox SQL remains the authority for access and folders. */
export async function mailBodyMatches(
  engine: SearchEngine | undefined,
  input: { readonly orgId: string; readonly actorId: string },
  terms: readonly string[],
  externalBodies: boolean,
): Promise<MailBodyMatches> {
  const matches = new Map<string, readonly string[]>();
  if (terms.length === 0) return matches;
  if (engine === undefined) {
    if (externalBodies)
      throw new ApiError(
        "internal_error",
        "Mail content search requires the search service. Ask an administrator to check its configuration.",
      );
    return matches;
  }
  for (const term of new Set(terms)) {
    const ids = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const page = await engine.search({
        query: JSON.stringify(term),
        types: ["mail"],
        limit: 500,
        offset,
        filter: [
          `attributes.orgId = ${JSON.stringify(input.orgId)}`,
          `attributes.ragOwnerActorId = ${JSON.stringify(input.actorId)}`,
        ],
        attributesToRetrieve: ["id", "type"],
        forOrgId: input.orgId,
        forActorId: input.actorId,
      });
      for (const hit of page.hits) {
        const prefix = `mail:${input.actorId}:`;
        if (!hit.id.startsWith(prefix)) continue;
        const id = hit.id.slice(prefix.length);
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id))
          ids.add(id);
      }
      if (
        offset + page.hits.length > MAIL_SEARCH_MAX_MATCHES ||
        (page.estimatedTotalHits ?? 0) > MAIL_SEARCH_MAX_MATCHES
      ) {
        throw new BadRequestError(
          "This mail search matches too many messages. Use a more specific word or quoted phrase.",
        );
      }
      if (page.hits.length < 500) break;
    }
    matches.set(term, [...ids]);
  }
  return matches;
}
