import type { JsonObject, JsonValue } from "@helix/sdk-types";

export interface IndexDocument {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly attributes?: JsonObject;
  readonly updatedAt?: string;
}

export interface SearchRequest {
  readonly query: string;
  readonly types?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  readonly filter?: string | readonly string[];
  readonly attributesToRetrieve?: readonly string[];
}

export interface SearchHit extends IndexDocument {
  readonly score?: number;
  readonly highlights?: JsonObject;
}

export interface SearchResponse {
  readonly hits: readonly SearchHit[];
  readonly query: string;
  readonly estimatedTotalHits?: number;
  readonly processingTimeMs?: number;
}

export interface SearchEngine {
  readonly id: string;
  index(document: IndexDocument): Promise<void>;
  upsert(documents: readonly IndexDocument[]): Promise<void>;
  delete(ids: readonly string[]): Promise<void>;
  search(request: SearchRequest): Promise<SearchResponse>;
}

export interface SearchIndexMutation {
  readonly upsert?: readonly IndexDocument[];
  readonly delete?: readonly string[];
}

export interface SearchIndexer<EventPayload extends JsonValue = JsonValue> {
  readonly id: string;
  readonly subjects: readonly string[];
  route(event: SearchIndexerEvent<EventPayload>): Promise<SearchIndexMutation | undefined>;
}

export interface SearchIndexerEvent<Payload extends JsonValue = JsonValue> {
  readonly subject: string;
  readonly payload: Payload;
  readonly occurredAt: string;
}
