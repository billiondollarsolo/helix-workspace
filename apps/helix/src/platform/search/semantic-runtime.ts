import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { DataClassification, HelixConfig, JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { isDataClassification } from "../ai/classification/effective.js";
import { deriveClassification, maxClassification } from "../ai/classification/policy.js";
import type { ResourceClassificationService } from "../ai/classification/service.js";
import { createSemanticSearchEmbeddingProvider } from "../ai/providers/factory.js";
import { createConfiguredVectorStore } from "../ai/vector/config.js";
import { PgVectorStore } from "../ai/vector/pgvector.js";
import { QdrantVectorStore } from "../ai/vector/qdrant.js";
import { validateVector } from "../ai/vector/types.js";
import { detectDlp } from "../dlp.js";
import { tierDefaults } from "../config/tier.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { SemanticSearchEngine } from "./semantic.js";
import { hydrateChunk, retrievalChunkSettings } from "./chunks.js";
import type { IndexDocument, SearchEngine, SearchHit, SearchRequest } from "./types.js";

export interface SemanticSearchStatus {
  readonly enabled: boolean;
  readonly backend: string | null;
  readonly embeddingModel: string | null;
  readonly dimensions: number | null;
  readonly collection: string | null;
  readonly blockedDocuments: number;
  readonly truncatedDocuments: number;
  readonly maxInputChars: number;
  readonly chunkOverlapChars: number;
  readonly chunkedDocuments: number;
}

export class SemanticSearchRuntime {
  private currentConfig: HelixConfig | undefined;
  private prepared: ReturnType<SemanticSearchRuntime["prepare"]>;
  private blockedDocuments = 0;
  private chunkedDocuments = 0;

  constructor(
    private readonly options: {
      readonly sql: postgres.Sql;
      readonly getConfig: () => HelixConfig;
      readonly classifications: Pick<ResourceClassificationService, "get">;
      readonly env?: NodeJS.ProcessEnv;
      readonly fetch?: typeof fetch;
      readonly resolveDocument?: (
        request: SearchRequest,
        hit: SearchHit,
      ) => Promise<IndexDocument | null>;
      readonly loadDocument?: (document: IndexDocument) => Promise<IndexDocument | null>;
    },
  ) {}

  validate(config: HelixConfig): void {
    this.prepare(config);
  }

  async classifyHit(request: SearchRequest, hit: SearchHit): Promise<SearchHit | null> {
    const document =
      this.options.resolveDocument === undefined
        ? hit
        : await this.options.resolveDocument(request, hit);
    if (document === null) return null;
    const classification = await this.classifyDocument(document);
    const passage =
      this.options.resolveDocument === undefined
        ? document
        : hydrateChunk(document, hit.attributes);
    if (passage === null) return null;
    return {
      ...passage,
      ...(hit.score === undefined ? {} : { score: hit.score }),
      attributes: {
        ...passage.attributes,
        classification,
        ...(typeof hit.attributes?.searchProvenance === "string"
          ? { searchProvenance: hit.attributes.searchProvenance }
          : {}),
      },
    };
  }

  status(): SemanticSearchStatus {
    const active = this.current();
    return {
      enabled: active !== undefined,
      backend: active?.vectorStore.id ?? null,
      embeddingModel: active?.model ?? null,
      dimensions: active?.dimensions ?? null,
      collection: active?.collection ?? null,
      blockedDocuments: this.blockedDocuments,
      truncatedDocuments: 0,
      maxInputChars: active?.maxInputChars ?? 1024,
      chunkOverlapChars: active?.chunking.overlap ?? 153,
      chunkedDocuments: this.chunkedDocuments,
    };
  }

  async test(orgId: string) {
    const started = performance.now();
    let ok = false;
    let message: string;
    try {
      const active = this.current();
      if (active === undefined)
        throw new Error(
          "Semantic search is disabled. Save an enabled backend and embedding provider first.",
        );
      await active.embeddings.embed(["Helix embedding connection test"]);
      const collection = await active.vectorStore.getCollection(orgId, active.collection);
      if (active.vectorStore instanceof PgVectorStore) {
        const rows = await this.options.sql<
          { installed: boolean }[]
        >`select exists(select 1 from pg_extension where extname = 'vector') as installed`;
        if (rows[0]?.installed !== true)
          throw new Error("The PostgreSQL vector extension is not installed.");
      }
      if (
        collection !== undefined &&
        (collection.dim !== active.dimensions || collection.metric !== "cosine")
      )
        throw new Error(
          "Vector collection dimensions or metric do not match the saved embedding provider.",
        );
      ok = true;
      message =
        collection === undefined
          ? "Embedding and vector connections work. Reindex existing workspace content to populate this collection."
          : "Embedding dimensions and vector collection are compatible.";
    } catch (error) {
      // Provider errors are already redacted; do not return remote response bodies.
      message = error instanceof Error ? error.message : "Retrieval connection test failed.";
    }
    return {
      ok,
      message,
      latencyMs: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(),
    };
  }

  wrap(keyword: SearchEngine): SearchEngine {
    const current = () => {
      const active = this.current();
      if (active === undefined) return keyword;
      return new SemanticSearchEngine({
        keyword,
        embeddings: active.embeddings,
        vectorStore: active.vectorStore,
        collection: active.collection,
        chunking: active.chunking,
        onChunkedDocument: () => {
          this.chunkedDocuments++;
        },
        allowDocument: async (document) => {
          const classification = await this.classifyDocument(document);
          const allowed = permits(active.config, active.external, classification);
          if (!allowed) this.blockedDocuments++;
          return allowed;
        },
        allowQuery: async (request) => {
          if (
            !permits(
              active.config,
              active.external,
              maxClassification(
                request.classification ?? "standard",
                detectDlp(request.query, new Set(["credentials"])).length > 0
                  ? "restricted"
                  : deriveClassification({ content: request.query, scanContent: true })
                      .classification,
              ),
            )
          )
            return false;
          const orgId = request.forOrgId;
          if (orgId === undefined) return false;
          return (await active.vectorStore.getCollection(orgId, active.collection)) !== undefined;
        },
      });
    };
    const upsert = async (documents: readonly IndexDocument[]) => {
      const engine = current();
      const groups = new Map<string, IndexDocument[]>();
      for (const document of documents) {
        const orgId = stringValue(document.attributes ?? {}, "orgId");
        if (orgId === undefined) {
          await keyword.index(document);
          continue;
        }
        const group = groups.get(orgId) ?? [];
        group.push(document);
        groups.set(orgId, group);
      }
      for (const [orgId, group] of groups)
        await withTenantPostgresContext(this.options.sql, { orgId }, async () => {
          const loaded: IndexDocument[] = [];
          for (const source of group) {
            const document =
              this.options.loadDocument === undefined
                ? source
                : await this.options.loadDocument(source);
            if (document === null) await engine.delete([source.id], orgId);
            else loaded.push(document);
          }
          await engine.upsert(loaded);
        });
    };
    return {
      id: `${keyword.id}+configured-semantic`,
      index: (document) => upsert([document]),
      upsert,
      delete: (ids, orgId) =>
        orgId === undefined
          ? keyword.delete(ids)
          : withTenantPostgresContext(this.options.sql, { orgId }, async () =>
              current().delete(ids, orgId),
            ),
      search: (request) => current().search(request),
    };
  }

  private current() {
    const config = this.options.getConfig();
    if (config !== this.currentConfig) {
      const next = this.prepare(config);
      this.prepared = next;
      this.currentConfig = config;
      this.blockedDocuments = 0;
      this.chunkedDocuments = 0;
    }
    return this.prepared;
  }

  private prepare(config: HelixConfig) {
    const ai = config.ai;
    if (
      ai?.enabled === false ||
      ai?.vectorStore === undefined ||
      ai.vectorStore.config?.enabled === false
    )
      return undefined;
    const vectorStore = createConfiguredVectorStore(ai, {
      sql: this.options.sql,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    });
    if (!(vectorStore instanceof PgVectorStore) && !(vectorStore instanceof QdrantVectorStore))
      throw new TypeError("Semantic search supports pgvector or Qdrant.");
    const source = createSemanticSearchEmbeddingProvider(ai, this.options.env, this.options.fetch);
    const embedding = ai.embeddingProvider?.config ?? {};
    const dimensions = embedding.defaultDimensions ?? embedding.dimensions;
    const model = stringValue(embedding, "defaultModel") ?? stringValue(embedding, "model");
    if (source === undefined || typeof dimensions !== "number" || model === undefined)
      throw new TypeError("Semantic search requires an embedding model and dimensions.");
    if (vectorStore instanceof PgVectorStore && dimensions > 16_000)
      throw new TypeError("pgvector supports at most 16000 dimensions");
    const embeddingUrl = stringValue(embedding, "baseUrl") ?? "https://api.openai.com/v1";
    const vectorUrl =
      stringValue(ai.vectorStore.config ?? {}, "baseUrl") ??
      stringValue(ai.vectorStore.config ?? {}, "url");
    const external =
      !isLocalEndpoint(embeddingUrl) ||
      (vectorStore instanceof QdrantVectorStore &&
        (vectorUrl === undefined || !isLocalEndpoint(vectorUrl)));
    if (external && localOnly(config))
      throw new TypeError("This security tier requires local embedding and vector endpoints.");
    const chunking = retrievalChunkSettings(embedding);
    const maxInputChars = chunking.size;
    const fingerprint = JSON.stringify([
      vectorStore.id,
      vectorUrl ?? "postgres",
      embeddingUrl,
      model,
      dimensions,
      maxInputChars,
      chunking.overlap,
      "chunks-v1",
    ]);
    const collection = `helix_search_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
    const embeddings = {
      async embed(texts: readonly string[]) {
        const vectors = await source.embed(texts);
        if (vectors.length !== texts.length)
          throw new TypeError("Embedding response count does not match inputs.");
        vectors.forEach((vector) => validateVector(vector, dimensions));
        return vectors;
      },
    };
    return {
      config,
      vectorStore,
      embeddings,
      model,
      dimensions,
      collection,
      external,
      maxInputChars,
      chunking,
    };
  }

  private async classifyDocument(document: IndexDocument): Promise<DataClassification> {
    const attributes = document.attributes ?? {};
    const orgId = stringValue(attributes, "orgId");
    const resource: readonly [string, unknown] | undefined =
      document.type === "drive"
        ? ["drive.file", attributes.fileId]
        : document.type === "mail"
          ? ["mail.message", attributes.messageId]
          : document.type === "chat"
            ? ["chat.message", attributes.messageId]
            : document.type === "calendar"
              ? ["calendar.event", attributes.eventId]
              : undefined;
    if (resource === undefined || orgId === undefined || typeof resource[1] !== "string")
      return "restricted";
    const refs: (readonly [string, string])[] = [[resource[0], resource[1]]];
    if (document.type === "mail" || document.type === "chat") {
      const parentId = attributes[document.type === "mail" ? "threadId" : "roomId"];
      if (typeof parentId !== "string" || parentId.length === 0) return "restricted";
      refs.push(
        [document.type === "mail" ? "mail.thread" : "chat.room", parentId],
        ["thread", parentId],
      );
    } else if (document.type === "drive" && typeof attributes.parentFolderId === "string") {
      refs.push(["folder", attributes.parentFolderId]);
    }
    const canonical = await Promise.all(
      refs.map(([resourceType, resourceId]) =>
        this.options.classifications.get({ orgId, resourceType, resourceId }),
      ),
    );
    const labels = [...stringArray(attributes.labels), ...stringArray(attributes.tags)];
    const content = classificationContent(document);
    if (detectDlp(content, new Set(["credentials"])).length > 0) return "restricted";
    const derived = deriveClassification({
      content,
      scanContent: true,
      labels,
      path: stringArray(attributes.path).join("/"),
      ...(isDataClassification(attributes.classification)
        ? { explicit: attributes.classification }
        : {}),
    }).classification;
    let classification = derived;
    for (const record of canonical) {
      if (record === null) continue;
      if (record.orgId !== orgId || !isDataClassification(record.classification))
        return "restricted";
      classification = maxClassification(classification, record.classification);
    }
    return classification;
  }
}

function classificationContent(document: IndexDocument): string {
  let content = [document.title, document.body].filter(Boolean).join("\n");
  if (document.type === "calendar" || document.type === "chat") {
    const ids = [
      document.attributes?.organizerId,
      document.attributes?.authorId,
      document.attributes?.roomId,
      ...stringArray(document.attributes?.mentions),
      ...stringArray(document.attributes?.reactionActorIds),
      ...stringArray(document.attributes?.attendeeActorIds),
    ];
    for (const id of ids) {
      if (typeof id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(id))
        content = content.replaceAll(id, "");
    }
  }
  return content;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function stringValue(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function localOnly(config: HelixConfig): boolean {
  return (
    config.security.tier === "sovereign" ||
    (config.security.overrides?.localAiOnly ?? tierDefaults[config.security.tier].localAiOnly)
  );
}
function permits(
  config: HelixConfig,
  external: boolean,
  classification: DataClassification,
): boolean {
  return (
    !external ||
    (!localOnly(config) &&
      classification !== "restricted" &&
      !(
        config.ai?.privacy?.blockExternalForClassifications ?? ["confidential", "restricted"]
      ).includes(classification))
  );
}
const localAddresses = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
] as const)
  localAddresses.addSubnet(network, prefix, "ipv4");
localAddresses.addSubnet("fc00::", 7, "ipv6");
localAddresses.addAddress("::1", "ipv6");
function isLocalEndpoint(value: string): boolean {
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    (isIP(hostname) !== 0 && localAddresses.check(hostname, isIP(hostname) === 6 ? "ipv6" : "ipv4"))
  );
}
