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
  readonly hydrate?: (request: SearchRequest, hit: SearchHit) => Promise<SearchHit | null>;
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
    readonly mail: {
      getMailSearchRecord(input: {
        readonly orgId: string;
        readonly actorId: string;
        readonly messageId: string;
      }): Promise<object | null>;
    };
    readonly drive: {
      getDriveSearchRecord(fileId: string): Promise<{
        readonly orgId: string;
        readonly allowedActorIds?: readonly string[] | undefined;
      } | null>;
    };
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
  const orgId = hit.attributes?.orgId;
  const actorId = request.forActorId;
  if (request.forOrgId !== undefined && orgId !== request.forOrgId) return false;
  if (
    hit.attributes?.ragVisibility === "private" &&
    (actorId === undefined || hit.attributes.ragOwnerActorId !== actorId)
  )
    return false;
  if (hit.type === "mail") {
    const messageId = hit.attributes?.messageId;
    // Each mailbox has its own projection. A recipient must never receive
    // the sender's projection, which legitimately includes Bcc addresses.
    if (
      actorId === undefined ||
      hit.attributes?.ragOwnerActorId !== actorId ||
      typeof orgId !== "string" ||
      typeof messageId !== "string"
    )
      return false;
    return stores.mail
      .getMailSearchRecord({ orgId, actorId, messageId })
      .then((record) => record !== null);
  }
  if (hit.type === "drive") {
    const fileId = hit.attributes?.fileId;
    if (actorId === undefined || typeof orgId !== "string" || typeof fileId !== "string")
      return false;
    return stores.drive
      .getDriveSearchRecord(fileId)
      .then(
        (record) => record?.orgId === orgId && record.allowedActorIds?.includes(actorId) === true,
      );
  }
  if (hit.type !== "contact") return authorizeChatSearchHit(stores.chat, request, hit);
  if (actorId === undefined) return false;
  const contactId = hit.attributes?.contactId;
  if (typeof orgId !== "string" || typeof contactId !== "string") return false;
  return stores.contacts
    .getContactByIdForActor({ orgId, actorId, contactId })
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
      response.hits.map(async (hit) => {
        if (!(await this.options.authorize(request, hit))) return null;
        return this.options.hydrate === undefined ? hit : this.options.hydrate(request, hit);
      }),
    );
    const authorized = decisions.filter((hit): hit is SearchHit => hit !== null);
    return {
      ...response,
      hits: authorized.slice(offset, offset + limit),
      estimatedTotalHits: authorized.length,
    };
  }
}
