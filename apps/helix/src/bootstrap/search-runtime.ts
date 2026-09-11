import { envFlag } from "../bootstrap/env.js";
import { createSearchEngine } from "../bootstrap/search.js";
import { EnrichmentWorker } from "../platform/ai/index.js";
import { SemanticSearchRuntime } from "../platform/search/semantic-runtime.js";
import { resolveSearchSourceDocument } from "../platform/search/source-documents.js";
import { registerCalendarIndexer } from "../platform/calendar/index.js";
import { registerCardDavIndexer } from "../platform/carddav/index.js";
import { registerChatEnrichments, registerChatIndexer } from "../platform/chat/index.js";
import {
  driveRecordToIndexDocument,
  registerDriveEnrichments,
  registerDriveIndexer,
} from "../platform/drive/index.js";
import { registerMailEnrichments, registerMailIndexer } from "../platform/mail/index.js";
import {
  authorizeWorkspaceSearchHit,
  AuthorizingSearchEngine,
  createPostgresSearchReindexSources,
  PostgresSearchDurabilityStore,
  PostgresSearchReindexJobService,
  SearchEventIndexer,
  SearchMutationWorker,
  SearchReconciliationWorker,
  SearchReindexService,
  SearchShadowReindexWorker,
} from "../platform/search/index.js";
import type { installStorage } from "./storage.js";

export async function installSearch(context: Awaited<ReturnType<typeof installStorage>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    calendarStore,
    cardDavContactStore,
    eventBus,
    chatStore,
    runtimeConfiguration,
    coreApps,
    assistantAi,
    driveConfig,
    mailStore,
    driveStore,
  } = context;
  const searchEngine = await createSearchEngine(bootEnv.HELIX_REGION);

  const semanticSearchRuntime = new SemanticSearchRuntime({
    sql,
    getConfig: () => runtimeConfiguration.current,
    classifications: context.resourceClassificationService,
    loadDocument: async (document) => {
      if (document.type !== "drive") return document;
      const fileId = document.attributes?.fileId;
      if (typeof fileId !== "string") return null;
      const record = await driveStore.getDriveSearchRecord(fileId, true);
      return record === null || record.orgId !== document.attributes?.orgId
        ? null
        : driveRecordToIndexDocument(record);
    },
    resolveDocument: (request, hit) =>
      resolveSearchSourceDocument(
        {
          mail: mailStore,
          drive: { getDriveSearchRecord: (id) => driveStore.getDriveSearchRecord(id, true) },
          chat: chatStore,
          calendar: calendarStore,
        },
        request,
        hit,
      ),
  });
  const projectedSearchEngine =
    searchEngine === undefined ? undefined : semanticSearchRuntime.wrap(searchEngine);

  const runtimeSearchEngine =
    projectedSearchEngine === undefined
      ? undefined
      : new AuthorizingSearchEngine({
          engine: projectedSearchEngine,
          hydrate: (request, hit) => semanticSearchRuntime.classifyHit(request, hit),
          authorize: (request, hit) =>
            authorizeWorkspaceSearchHit(
              {
                chat: chatStore,
                contacts: cardDavContactStore,
                mail: mailStore,
                drive: driveStore,
              },
              request,
              hit,
            ),
        });

  const searchSources = createPostgresSearchReindexSources(sql);

  const searchDurabilityStore =
    searchEngine === undefined ? undefined : new PostgresSearchDurabilityStore(sql);

  const searchReindexJobService =
    searchDurabilityStore === undefined
      ? undefined
      : new PostgresSearchReindexJobService(searchDurabilityStore);

  const searchEventIndexer =
    runtimeSearchEngine === undefined
      ? undefined
      : new SearchEventIndexer({
          events: eventBus,
          engine: runtimeSearchEngine,
          ...(searchDurabilityStore === undefined ? {} : { queue: searchDurabilityStore }),
          metrics,
          subject: bootEnv.SEARCH_EVENT_SUBJECT,
          onError: (error) => {
            app.log.error({ error }, "Search event indexer error");
          },
        });

  const searchReindexService =
    runtimeSearchEngine === undefined
      ? undefined
      : new SearchReindexService({
          engine: runtimeSearchEngine,
          sources: searchSources,
          batchSize: bootEnv.SEARCH_REINDEX_BATCH_SIZE,
        });

  const searchMutationWorker =
    searchDurabilityStore === undefined ||
    runtimeSearchEngine === undefined ||
    searchEngine === undefined
      ? undefined
      : new SearchMutationWorker({
          store: searchDurabilityStore,
          engine: runtimeSearchEngine,
          shadowEngine: (uid) => searchEngine.forIndex(uid),
          onError: (error) => {
            app.log.error({ error }, "Durable search projection failed");
          },
        });

  const searchShadowReindexWorker =
    searchDurabilityStore === undefined || searchEngine === undefined
      ? undefined
      : new SearchShadowReindexWorker({
          store: searchDurabilityStore,
          sources: searchSources,
          shadowEngine: (uid) => {
            const keyword = searchEngine.forIndex(uid);
            return Object.assign(semanticSearchRuntime.wrap(keyword), {
              ensureIndex: () => keyword.ensureIndex(),
            });
          },
          swap: (uid) => searchEngine.swapWith(uid),
          onError: (error) => {
            app.log.error({ error }, "Shadow search reindex failed");
          },
        });

  const searchReconciliationWorker =
    searchReindexService === undefined
      ? undefined
      : new SearchReconciliationWorker({
          service: searchReindexService,
          onResult: (result) => {
            metrics.recordOperationalEvent({
              capability: "search",
              operation: "reconcile",
              status: "success",
            });
            metrics.addOperationalUnits({
              capability: "search",
              measure: "reconciled_documents",
              value: result.totalDocuments,
            });
            metrics.setOperationalState({
              capability: "search",
              measure: "drift_objects",
              value: result.deletedDocuments,
            });
            if (result.deletedDocuments > 0) {
              app.log.info(
                { deletedDocuments: result.deletedDocuments },
                "Search reconciliation removed stale Drive projections",
              );
            }
          },
          onError: (error) => {
            metrics.recordOperationalEvent({
              capability: "search",
              operation: "reconcile",
              status: "error",
            });
            app.log.error({ error }, "Search reconciliation failed");
          },
        });

  if (searchEventIndexer !== undefined) {
    registerCardDavIndexer(searchEventIndexer);
    // Indexers are registered per core app, conditionally on enablement +
    // role. A disabled app contributes no search indexer.
    if (coreApps.shouldRegister("mail")) {
      registerMailIndexer(searchEventIndexer, mailStore);
    }
    if (coreApps.shouldRegister("chat")) {
      registerChatIndexer(searchEventIndexer, chatStore);
    }
    if (coreApps.shouldRegister("drive")) {
      registerDriveIndexer(searchEventIndexer, driveStore);
    }
    if (coreApps.shouldRegister("calendar")) {
      registerCalendarIndexer(searchEventIndexer, calendarStore);
    }
  }

  const enrichmentWorker = new EnrichmentWorker({
    events: eventBus,
    subject: bootEnv.ENRICHMENT_EVENT_SUBJECT,
    onResult: (result, event) => {
      app.log.debug({ result, subject: event.subject }, "AI enrichment applied");
    },
    onError: (error, event, handler) => {
      app.log.error(
        { error, subject: event.subject, handlerId: handler.id },
        "AI enrichment handler error",
      );
    },
  });

  // AI enrichment handlers are registered per core app, conditionally on
  // enablement + role.
  if (coreApps.shouldRegister("mail")) {
    registerMailEnrichments(enrichmentWorker, {
      store: mailStore,
      ai: assistantAi,
      entityExtract: envFlag("MAIL_ENTITY_EXTRACT_ENRICHMENT", true),
      classification: envFlag("MAIL_CLASSIFICATION_ENRICHMENT", true),
    });
  }

  if (coreApps.shouldRegister("chat")) {
    registerChatEnrichments(enrichmentWorker, {
      store: chatStore,
      ai: assistantAi,
      actionItems: envFlag("CHAT_ACTION_ITEMS_ENRICHMENT", true),
    });
  }

  if (coreApps.shouldRegister("drive")) {
    registerDriveEnrichments(enrichmentWorker, {
      store: driveStore,
      ai: assistantAi,
      autoTag: driveConfig.autoTagEnrichment,
    });
  }
  return {
    ...context,
    searchEngine,
    projectedSearchEngine,
    semanticSearchRuntime,
    runtimeSearchEngine,
    searchReindexJobService,
    searchEventIndexer,
    searchReindexService,
    searchMutationWorker,
    searchShadowReindexWorker,
    searchReconciliationWorker,
    enrichmentWorker,
  };
}
