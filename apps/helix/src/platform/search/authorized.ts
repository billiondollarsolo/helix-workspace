import type {
  IndexDocument,
  SearchEngine,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from "./types.js";

export interface AuthorizingSearchEngineOptions {
  readonly engine: SearchEngine;
  readonly authorize: (request: SearchRequest, hit: SearchHit) => boolean | Promise<boolean>;
}

export function authorizeChatSearchHit(
  store: {
    getRoomForActor(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly roomId: string;
    }): Promise<{ readonly id: string } | null>;
  },
  request: SearchRequest,
  hit: SearchHit,
): boolean | Promise<boolean> {
  if (hit.type !== "chat" || request.forActorId === undefined) return true;
  const orgId = hit.attributes?.orgId;
  const roomId = hit.attributes?.roomId;
  if (typeof orgId !== "string" || typeof roomId !== "string") return false;
  return store
    .getRoomForActor({ orgId, actorId: request.forActorId, roomId })
    .then((room) => room !== null);
}

export function authorizeWorkspaceSearchHit(
  stores: {
    readonly chat: Parameters<typeof authorizeChatSearchHit>[0];
    readonly contacts: {
      getContactByIdForActor(input: {
        readonly orgId: string;
        readonly actorId: string;
        readonly contactId: string;
      }): Promise<object | null>;
    };
  },
  request: SearchRequest,
  hit: SearchHit,
): boolean | Promise<boolean> {
  if (hit.type !== "contact") return authorizeChatSearchHit(stores.chat, request, hit);
  if (request.forActorId === undefined) return false;
  const orgId = hit.attributes?.orgId;
  const contactId = hit.attributes?.contactId;
  if (typeof orgId !== "string" || typeof contactId !== "string") return false;
  return stores.contacts
    .getContactByIdForActor({ orgId, actorId: request.forActorId, contactId })
    .then((contact) => contact !== null);
}

/** Final, authoritative result gate for indexes whose ACL projection can lag. */
export class AuthorizingSearchEngine implements SearchEngine {
  readonly id: string;

  constructor(private readonly options: AuthorizingSearchEngineOptions) {
    this.id = `${options.engine.id}+authorized`;
  }

  index(document: IndexDocument): Promise<void> {
    return this.options.engine.index(document);
  }

  upsert(documents: readonly IndexDocument[]): Promise<void> {
    return this.options.engine.upsert(documents);
  }

  delete(ids: readonly string[], orgId?: string): Promise<void> {
    return this.options.engine.delete(ids, orgId);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const limit = request.limit ?? 10;
    const offset = request.offset ?? 0;
    const response = await this.options.engine.search({
      ...request,
      limit: Math.min(1000, Math.max(limit + offset, (limit + offset) * 3)),
      offset: 0,
    });
    const decisions = await Promise.all(
      response.hits.map(async (hit) => ((await this.options.authorize(request, hit)) ? hit : null)),
    );
    const authorized = decisions.filter((hit): hit is SearchHit => hit !== null);
    return {
      ...response,
      hits: authorized.slice(offset, offset + limit),
      estimatedTotalHits: authorized.length,
    };
  }
}
