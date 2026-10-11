import { deriveClassification } from "../platform/ai/index.js";
import { createSemanticSearchEmbeddingProvider } from "../platform/ai/providers/factory.js";
import {
  AssistantOrchestrator,
  AssistantSlashCommandHooks,
  registerAssistantTools,
  type AssistantCitationAccess,
} from "../platform/assistant/index.js";
import { ASSISTANT_RETRIEVAL_FLAG } from "../platform/assistant/context-policy.js";
import { PostgresAssistantFeedbackStore } from "../platform/assistant/message-annotations.js";
import type { TenantConfigFeatureFlagProvider } from "../platform/feature-flags/provider.js";
import { resolveSearchSourceDocument } from "../platform/search/source-documents.js";
import type { GlobalSearchType } from "../platform/search/scope.js";
import { getWebSearchEnabled } from "../platform/search/web.js";
import type { RuntimeToolRegistry } from "../platform/tool-registry.js";
import type { ConfirmationGate } from "../platform/tools/registry.js";
import { loadAssistantAttachments } from "./assistant-attachments.js";
import { createAssistantToolResultClassifier } from "./assistant-tool-classification.js";
import type { installAuditWorkers } from "./audit-workers.js";

/** Search hit attribute that names each citable record's id. */
const citationAttribute: Record<GlobalSearchType, string> = {
  mail: "messageId",
  chat: "messageId",
  drive: "fileId",
  calendar: "eventId",
};

/**
 * Assistant orchestration, its tools, and the reader-specific view of saved
 * answers (re-checked workspace citations and feedback).
 */
export function installAssistantRuntime(
  context: Awaited<ReturnType<typeof installAuditWorkers>>,
  input: {
    readonly tools: RuntimeToolRegistry;
    readonly confirmationGate: ConfirmationGate;
    readonly featureFlags: TenantConfigFeatureFlagProvider;
    readonly webSearchAllowed: () => boolean;
  },
): AssistantOrchestrator {
  const { coreApps, assistantAi, assistantStore, driveStore } = context;
  const { tools } = input;
  const ai = () => context.runtimeConfiguration.current.ai;

  const assistantSlashCommands = new AssistantSlashCommandHooks();
  if (!coreApps.shouldRegister("calendar")) {
    assistantSlashCommands.register("schedule", () => ({
      instruction:
        "Calendar scheduling is unavailable in this deployment. Explain that no calendar action was taken.",
      searchQuery: "",
      toolIds: [],
    }));
  }

  const attachmentEmbedder = createSemanticSearchEmbeddingProvider(ai(), process.env);
  const assistantSearchTypes: readonly GlobalSearchType[] = [
    ...(coreApps.shouldRegister("mail") ? (["mail"] as const) : []),
    ...(coreApps.shouldRegister("chat") ? (["chat"] as const) : []),
    ...(coreApps.shouldRegister("drive") ? (["drive"] as const) : []),
    ...(coreApps.shouldRegister("calendar") ? (["calendar"] as const) : []),
  ];

  // The same authoritative reload search uses before a hit reaches a prompt.
  const citationAccess: AssistantCitationAccess = async (actor, ref) => {
    if (!assistantSearchTypes.includes(ref.kind)) return null;
    const document = await resolveSearchSourceDocument(
      {
        mail: context.mailStore,
        drive: { getDriveSearchRecord: (id) => driveStore.getDriveSearchRecord(id, true) },
        chat: context.chatStore,
        calendar: context.calendarStore,
      },
      { query: "", forOrgId: actor.orgId, forActorId: actor.id },
      {
        id: `${ref.kind}:${ref.id}`,
        type: ref.kind,
        attributes: { orgId: actor.orgId, [citationAttribute[ref.kind]]: ref.id },
      },
    );
    return document?.url === undefined ? null : { path: document.url };
  };
  const feedback = new PostgresAssistantFeedbackStore(context.sql);

  const orchestrator = new AssistantOrchestrator({
    store: assistantStore,
    ai: assistantAi,
    listModels: () => assistantAi.listModels(),
    getMaxToolRounds: () => ai()?.assistant?.maxToolRounds ?? 128,
    webSearchEnabled: (classification) =>
      input.webSearchAllowed() &&
      getWebSearchEnabled(ai()) &&
      (classification === undefined ||
        !ai()?.privacy?.blockExternalForClassifications?.includes(classification)),
    loadAttachments: (request) =>
      loadAssistantAttachments(
        {
          driveStore,
          classifications: context.resourceClassificationService,
          dlp: context.dlp,
        },
        request,
      ),
    ...(attachmentEmbedder === undefined
      ? {}
      : { embed: (texts: readonly string[]) => attachmentEmbedder.embed(texts) }),
    generateTitles: true,
    tools,
    memory: context.assistantMemory,
    ...(context.runtimeSearchEngine === undefined ? {} : { search: context.runtimeSearchEngine }),
    searchTypes: assistantSearchTypes,
    retrievalEnabled: (actor) =>
      input.featureFlags.getAsync(ASSISTANT_RETRIEVAL_FLAG, true, {
        orgId: actor.orgId,
        actorId: actor.id,
      }),
    confirmationGate: input.confirmationGate,
    slashCommands: assistantSlashCommands,
    classifyUserInput: async ({ content }) =>
      deriveClassification({ content, scanContent: true }).classification,
    classifyToolResult: createAssistantToolResultClassifier(context.resourceClassificationService),
    blockHighRiskToolsWhenUntrusted: context.securityTier !== "personal",
    toolServers: () => ai()?.toolServers ?? [],
    annotations: { citationAccess, feedback },
  });

  if (coreApps.shouldRegister("assistant")) {
    registerAssistantTools(tools, { store: assistantStore, orchestrator, feedback });
  }
  return orchestrator;
}
