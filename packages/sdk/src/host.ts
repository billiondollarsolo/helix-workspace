import type {
  Actor,
  CacheClient,
  ConsumerHandler,
  DrizzleClient,
  EnrichmentHandler,
  EventBus,
  IndexerDefinition,
  Logger,
  MetricsClient,
  NotificationSource,
  PlatformCapabilities,
  PluginConfig,
  RequestContext,
  ResourceRef,
  RESTHandler,
  ScheduledJobDefinition,
  SlotProvider,
  SMTPHandler,
  SMTPListenerOpts,
  StorageClient,
  ToolDefinition,
  Tracer,
  TRPCRouter,
  WSHandler,
} from "./types.js";

import type { I18nClient } from "@helix/sdk-types";

export interface RegistrationSink {
  registerTRPCRouter(routerKey: string, router: TRPCRouter): void;
  registerRESTEndpoint(path: string, handler: RESTHandler): void;
  registerTool(tool: ToolDefinition): void;
  registerWebSocketHandler(path: string, handler: WSHandler): void;
  registerIndexer(indexer: IndexerDefinition): void;
  registerNotificationSource(source: NotificationSource): void;
  registerScheduledJob(job: ScheduledJobDefinition): void;
  registerNATSConsumer(subject: string, handler: ConsumerHandler): void;
  registerSMTPListener(opts: SMTPListenerOpts, handler: SMTPHandler): void;
  registerSuggestionSlotProvider(slot: string, provider: SlotProvider): void;
  registerEnrichmentSource(id: string, handler: EnrichmentHandler): void;
}

export interface PlatformHost extends RegistrationSink {
  readonly pluginId: string;
  readonly request?: RequestContext;
  readonly actor: Actor;
  readonly tracer: Tracer;
  readonly db: DrizzleClient;
  readonly storage: StorageClient;
  readonly cache: CacheClient;
  readonly events: EventBus;
  readonly capabilities: PlatformCapabilities;
  readonly metric: MetricsClient;
  readonly log: Logger;
  readonly config: PluginConfig;
  readonly i18n: I18nClient;
  can(action: string, resource: ResourceRef): Promise<boolean>;
  requirePermission(action: string, resource: ResourceRef): Promise<void>;
}

export interface PlatformHostServices {
  readonly pluginId: string;
  readonly request?: RequestContext;
  readonly actor: Actor;
  readonly tracer: Tracer;
  readonly db: DrizzleClient;
  readonly storage: StorageClient;
  readonly cache: CacheClient;
  readonly events: EventBus;
  readonly capabilities: PlatformCapabilities;
  readonly metric: MetricsClient;
  readonly log: Logger;
  readonly config: PluginConfig;
  readonly i18n: I18nClient;
  readonly registrations: RegistrationSink;
}

export function createPlatformHost(services: PlatformHostServices): PlatformHost {
  return {
    pluginId: services.pluginId,
    ...(services.request === undefined ? {} : { request: services.request }),
    actor: services.actor,
    tracer: services.tracer,
    db: services.db,
    storage: services.storage,
    cache: services.cache,
    events: services.events,
    capabilities: services.capabilities,
    metric: services.metric,
    log: services.log.child({ pluginId: services.pluginId }),
    config: services.config,
    i18n: services.i18n,
    can(action, resource) {
      return services.capabilities.permissions.can(services.actor, action, resource);
    },
    async requirePermission(action, resource) {
      await services.capabilities.permissions.require(services.actor, action, resource);
    },
    registerTRPCRouter(routerKey, router) {
      services.registrations.registerTRPCRouter(routerKey, router);
    },
    registerRESTEndpoint(path, handler) {
      services.registrations.registerRESTEndpoint(path, handler);
    },
    registerTool(tool) {
      services.registrations.registerTool(tool);
    },
    registerWebSocketHandler(path, handler) {
      services.registrations.registerWebSocketHandler(path, handler);
    },
    registerIndexer(indexer) {
      services.registrations.registerIndexer(indexer);
    },
    registerNotificationSource(source) {
      services.registrations.registerNotificationSource(source);
    },
    registerScheduledJob(job) {
      services.registrations.registerScheduledJob(job);
    },
    registerNATSConsumer(subject, handler) {
      services.registrations.registerNATSConsumer(subject, handler);
    },
    registerSMTPListener(opts, handler) {
      services.registrations.registerSMTPListener(opts, handler);
    },
    registerSuggestionSlotProvider(slot, provider) {
      services.registrations.registerSuggestionSlotProvider(slot, provider);
    },
    registerEnrichmentSource(id, handler) {
      services.registrations.registerEnrichmentSource(id, handler);
    },
  };
}
