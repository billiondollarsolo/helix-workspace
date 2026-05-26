import { addAccessTokenSearchParam, authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type DocsApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DocsExportFormat = "markdown" | "pdf" | "docx" | "epub";

export interface DocsApiDocument {
  readonly id: string;
  readonly orgId?: string;
  readonly title: string;
  readonly threadId: string | null;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly ydocState: string | null;
  readonly ydocStateVector: string | null;
  readonly updateSeq: number;
  readonly editorEngine?: string;
  readonly formatVersion?: number;
  readonly metadata: Record<string, unknown>;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeDocumentSession {
  readonly editor: "document";
  readonly engine: string;
  readonly formatVersion: number;
  readonly resource: {
    readonly orgId: string;
    readonly resourceId: string;
    readonly kind: "document";
  };
  readonly document: {
    readonly id: string;
    readonly orgId: string;
    readonly title: string;
    readonly editorEngine: string;
    readonly formatVersion: number;
    readonly updateSeq: number;
    readonly stateBase64: string | null;
    readonly stateVectorBase64: string | null;
    readonly layoutSettings?: NativeDocumentLayoutSettings;
    readonly updatedAt: string;
  };
  readonly shellRoute: string;
  readonly apiRoute: string;
  readonly sync: {
    readonly protocol: "yjs";
    readonly route: string;
    readonly url: string;
    readonly awareness: boolean;
  };
}

export interface NativeDocumentLayoutSettings {
  readonly layoutMode: "page" | "pageless";
  readonly columnCount: 1 | 2;
  readonly sections?: readonly NativeDocumentSectionSettings[] | undefined;
}

export interface NativeDocumentSectionSettings {
  readonly id: string;
  readonly title?: string | undefined;
  readonly layoutMode?: "page" | "pageless" | undefined;
  readonly columnCount?: 1 | 2 | undefined;
  readonly pageSize?: "letter" | "a4" | undefined;
  readonly orientation?: "portrait" | "landscape" | undefined;
}

export interface DocsCreateInput {
  readonly title: string;
  readonly initialMarkdown?: string;
  readonly editorEngine?: "legacy-yjs" | "onlyoffice-ooxml" | "helix-native-document";
  readonly formatVersion?: number;
  readonly folderId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface DocsListInput {
  readonly query?: string;
  readonly limit?: number;
}

export interface DocsExportResult {
  readonly docId: string;
  readonly format: DocsExportFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly text?: string;
  readonly metadata: Record<string, unknown>;
}

export interface DocsComment {
  readonly id: string;
  readonly orgId?: string;
  readonly documentId: string;
  readonly parentCommentId?: string | null;
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly body: string;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
  readonly author?: {
    readonly id: string;
    readonly displayName?: string;
    readonly email?: string;
  };
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export type DocsCommentStatusFilter = "open" | "resolved" | "all";

export type DocsSuggestionStatus = "pending" | "accepted" | "rejected";
export type DocsSuggestionSlotId =
  | "docs.smart-write"
  | "docs.summarize"
  | "docs.translate"
  | "docs.ask-document";

export interface DocsSuggestion {
  readonly id: string;
  readonly orgId?: string;
  readonly documentId: string;
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly beforeText: string;
  readonly afterText: string;
  readonly reason: string;
  readonly status: DocsSuggestionStatus;
  readonly metadata: Record<string, unknown>;
  readonly resolvedByActorId: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface DocsSuggestionDraft {
  readonly slotId: DocsSuggestionSlotId;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
}

export type DocsAskSourceScope = "document" | "selection";

export interface DocsAskCitation {
  readonly label: string;
  readonly excerpt: string;
  readonly sourceScope: DocsAskSourceScope;
  readonly selection?: {
    readonly from: number;
    readonly to: number;
    readonly text: string;
  };
}

export interface DocsAskHistoryItem {
  readonly id: string;
  readonly orgId?: string;
  readonly documentId: string;
  readonly actorId: string;
  readonly question: string;
  readonly answer: string;
  readonly sourceScope: DocsAskSourceScope;
  readonly sourceExcerpt: string;
  readonly metadata: Record<string, unknown>;
  readonly citations?: readonly DocsAskCitation[];
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface DocsVersion {
  readonly id: string;
  readonly orgId?: string;
  readonly documentId: string;
  readonly actorId: string | null;
  readonly seq: number;
  readonly byteSize: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface DocsVersionsPage {
  readonly versions: readonly DocsVersion[];
  readonly nextBeforeSeq: number | null;
}

export interface DocsVersionDiffLine {
  readonly kind: "unchanged" | "added" | "removed";
  readonly text: string;
}

export interface DocsVersionPreview {
  readonly version: DocsVersion;
  readonly documentId: string;
  readonly currentUpdateSeq: number;
  readonly currentText: string;
  readonly versionText: string;
  readonly completeness: "snapshot" | "reconstructed";
  readonly complete: boolean;
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly diff: readonly DocsVersionDiffLine[];
  readonly warnings: readonly string[];
}

export interface DocsVersionRestore {
  readonly document: DocsApiDocument;
  readonly restoredVersion: DocsVersion;
  readonly restoreVersion: DocsVersion;
}

export type DocsSyncEvent =
  | {
      readonly type: "ready";
      readonly documentId: string;
      readonly updateSeq: number;
      readonly stateBase64: string | null;
    }
  | {
      readonly type: "update";
      readonly documentId: string;
      readonly actorId: string;
      readonly seq: number;
      readonly updateBase64: string;
      readonly createdAt: string;
    }
  | { readonly type: "error"; readonly error: string };

export interface DocsSyncClient {
  sendUpdate(input: {
    readonly updateBase64: string;
    readonly stateBase64?: string;
    readonly metadata?: Record<string, unknown>;
  }): void;
  isOpen(): boolean;
  close(): void;
}

interface DocsSyncClientOptions {
  readonly docId: string;
  readonly url?: string;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly onError?: ((error: Event) => void) | undefined;
  readonly onEvent: (event: DocsSyncEvent) => void;
}

export async function createDocsDocument(
  input: DocsCreateInput,
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsApiDocument> {
  return callDocsTool<DocsApiDocument>(
    "docs.create",
    {
      title: input.title,
      initialMarkdown: input.initialMarkdown,
      ...(input.editorEngine === undefined ? {} : { editorEngine: input.editorEngine }),
      ...(input.formatVersion === undefined ? {} : { formatVersion: input.formatVersion }),
      folderId: input.folderId ?? null,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function importDocxDocument(
  input: {
    readonly filename?: string;
    readonly title?: string;
    readonly contentBase64: string;
    readonly folderId?: string | null;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsApiDocument> {
  return callDocsTool<DocsApiDocument>(
    "docs.import-docx",
    {
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      ...(input.title === undefined ? {} : { title: input.title }),
      contentBase64: input.contentBase64,
      folderId: input.folderId ?? null,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function listDocsDocuments(
  input: DocsListInput = {},
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<readonly DocsApiDocument[]> {
  const output = await callDocsTool<{ readonly documents?: readonly DocsApiDocument[] }>(
    "docs.list",
    {
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );
  return output.documents ?? [];
}

export async function exportDocsDocument(
  input: {
    readonly docId: string;
    readonly format?: DocsExportFormat;
    readonly includeComments?: boolean;
    readonly filename?: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsExportResult> {
  return callDocsTool<DocsExportResult>(
    "docs.export",
    {
      docId: input.docId,
      format: input.format ?? "markdown",
      includeComments: input.includeComments ?? false,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
    },
    fetchImpl,
  );
}

export async function updateDocsTitle(
  input: {
    readonly docId: string;
    readonly title: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsApiDocument> {
  return callDocsTool<DocsApiDocument>(
    "docs.update-title",
    {
      docId: input.docId,
      title: input.title,
    },
    fetchImpl,
  );
}

export async function updateDocsLayout(
  input: {
    readonly docId: string;
    readonly layoutSettings: NativeDocumentLayoutSettings;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsApiDocument> {
  return callDocsTool<DocsApiDocument>(
    "docs.update-layout",
    {
      docId: input.docId,
      layoutSettings: input.layoutSettings,
    },
    fetchImpl,
  );
}

export async function migrateDocsDocumentToNative(
  input: {
    readonly docId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsApiDocument> {
  return callDocsTool<DocsApiDocument>(
    "docs.migrate-native",
    {
      docId: input.docId,
    },
    fetchImpl,
  );
}

export async function getDocsDocument(
  input: {
    readonly docId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsApiDocument> {
  return callDocsTool<DocsApiDocument>(
    "docs.get",
    {
      docId: input.docId,
    },
    fetchImpl,
  );
}

export async function getNativeDocumentSession(
  input: { readonly documentId: string },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<NativeDocumentSession> {
  const response = await fetchImpl(
    `/api/editors/documents/${encodeURIComponent(input.documentId)}`,
    {
      method: "GET",
      headers: { "content-type": "application/json" },
    },
  );
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessageFromOutput(output) ?? `HTTP ${String(response.status)}`);
  }
  return output as NativeDocumentSession;
}

export async function listDocsComments(
  input: { readonly docId: string; readonly status?: DocsCommentStatusFilter },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<readonly DocsComment[]> {
  const output = await callDocsTool<{ readonly comments?: readonly DocsComment[] }>(
    "docs.comment.list",
    {
      docId: input.docId,
      status: input.status ?? "open",
    },
    fetchImpl,
  );
  return output.comments ?? [];
}

export async function createDocsComment(
  input: {
    readonly docId: string;
    readonly parentCommentId?: string;
    readonly body: string;
    readonly anchor?: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsComment> {
  return callDocsTool<DocsComment>(
    "docs.comment.create",
    {
      docId: input.docId,
      ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
      body: input.body,
      anchor: input.anchor ?? {},
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function resolveDocsComment(
  input: {
    readonly commentId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsComment> {
  return callDocsTool<DocsComment>(
    "docs.comment.resolve",
    {
      commentId: input.commentId,
    },
    fetchImpl,
  );
}

export async function reopenDocsComment(
  input: {
    readonly commentId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsComment> {
  return callDocsTool<DocsComment>(
    "docs.comment.reopen",
    {
      commentId: input.commentId,
    },
    fetchImpl,
  );
}

export async function updateDocsComment(
  input: {
    readonly commentId: string;
    readonly body: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsComment> {
  return callDocsTool<DocsComment>(
    "docs.comment.update",
    {
      commentId: input.commentId,
      body: input.body,
    },
    fetchImpl,
  );
}

export async function deleteDocsComment(
  input: {
    readonly commentId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsComment> {
  return callDocsTool<DocsComment>(
    "docs.comment.delete",
    {
      commentId: input.commentId,
    },
    fetchImpl,
  );
}

export async function createDocsSuggestion(
  input: {
    readonly docId: string;
    readonly beforeText: string;
    readonly afterText: string;
    readonly reason?: string;
    readonly anchor?: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsSuggestion> {
  return callDocsTool<DocsSuggestion>(
    "docs.suggestion.create",
    {
      docId: input.docId,
      beforeText: input.beforeText,
      afterText: input.afterText,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      anchor: input.anchor ?? {},
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function listDocsSuggestions(
  input: {
    readonly docId: string;
    readonly status?: DocsSuggestionStatus;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<readonly DocsSuggestion[]> {
  const output = await callDocsTool<{ readonly suggestions?: readonly DocsSuggestion[] }>(
    "docs.suggestion.list",
    {
      docId: input.docId,
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    fetchImpl,
  );
  return output.suggestions ?? [];
}

export async function generateDocsSuggestionDraft(
  input: {
    readonly docId: string;
    readonly slotId: DocsSuggestionSlotId;
    readonly selection: string;
    readonly body?: string;
    readonly prompt?: string;
    readonly targetLanguage?: string;
    readonly classification?: "public" | "standard" | "confidential" | "restricted";
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsSuggestionDraft> {
  return callDocsTool<DocsSuggestionDraft>(
    "docs.suggestion.generate",
    {
      docId: input.docId,
      slotId: input.slotId,
      selection: input.selection,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.targetLanguage === undefined ? {} : { targetLanguage: input.targetLanguage }),
      ...(input.classification === undefined ? {} : { classification: input.classification }),
    },
    fetchImpl,
  );
}

export async function answerDocsQuestion(
  input: {
    readonly docId: string;
    readonly question: string;
    readonly selection: string;
    readonly body?: string;
    readonly sourceScope?: DocsAskSourceScope;
    readonly citations?: readonly DocsAskCitation[];
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsAskHistoryItem> {
  const output = await callDocsTool<DocsAskHistoryItem>(
    "docs.ask.answer",
    {
      docId: input.docId,
      question: input.question,
      selection: input.selection,
      ...(input.body === undefined ? {} : { body: input.body }),
      sourceScope: input.sourceScope ?? "document",
      ...(input.citations === undefined ? {} : { citations: input.citations }),
    },
    fetchImpl,
  );
  return docsAskHistoryItemFromOutput(output);
}

export async function listDocsAskHistory(
  input: {
    readonly docId: string;
    readonly limit?: number;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<readonly DocsAskHistoryItem[]> {
  const output = await callDocsTool<{ readonly history?: readonly DocsAskHistoryItem[] }>(
    "docs.ask.history.list",
    {
      docId: input.docId,
      limit: input.limit ?? 10,
    },
    fetchImpl,
  );
  return (output.history ?? []).map(docsAskHistoryItemFromOutput);
}

export async function clearDocsAskHistory(
  input: {
    readonly docId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<number> {
  const output = await callDocsTool<{ readonly deleted?: number }>(
    "docs.ask.history.clear",
    {
      docId: input.docId,
    },
    fetchImpl,
  );
  return output.deleted ?? 0;
}

export async function listDocsVersions(
  input: {
    readonly docId: string;
    readonly limit?: number;
    readonly beforeSeq?: number | undefined;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<readonly DocsVersion[]> {
  return (await listDocsVersionsPage(input, fetchImpl)).versions;
}

export async function listDocsVersionsPage(
  input: {
    readonly docId: string;
    readonly limit?: number;
    readonly beforeSeq?: number | undefined;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsVersionsPage> {
  const output = await callDocsTool<{
    readonly versions?: readonly DocsVersion[];
    readonly nextBeforeSeq?: number | null;
  }>(
    "docs.version.list",
    {
      docId: input.docId,
      limit: input.limit ?? 25,
      ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
    },
    fetchImpl,
  );
  return {
    versions: output.versions ?? [],
    nextBeforeSeq: output.nextBeforeSeq ?? null,
  };
}

export async function renameDocsVersion(
  input: {
    readonly versionId: string;
    readonly name: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsVersion> {
  return callDocsTool<DocsVersion>(
    "docs.version.rename",
    {
      versionId: input.versionId,
      name: input.name,
    },
    fetchImpl,
  );
}

export async function previewDocsVersion(
  input: {
    readonly versionId: string;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsVersionPreview> {
  return callDocsTool<DocsVersionPreview>(
    "docs.version.preview",
    {
      versionId: input.versionId,
    },
    fetchImpl,
  );
}

export async function restoreDocsVersion(
  input: {
    readonly versionId: string;
    readonly expectedCurrentUpdateSeq?: number | undefined;
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsVersionRestore> {
  return callDocsTool<DocsVersionRestore>(
    "docs.version.restore",
    {
      versionId: input.versionId,
      ...(input.expectedCurrentUpdateSeq === undefined
        ? {}
        : { expectedCurrentUpdateSeq: input.expectedCurrentUpdateSeq }),
    },
    fetchImpl,
  );
}

export async function resolveDocsSuggestion(
  input: {
    readonly suggestionId: string;
    readonly status: "accepted" | "rejected";
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<DocsSuggestion> {
  return callDocsTool<DocsSuggestion>(
    "docs.suggestion.resolve",
    {
      suggestionId: input.suggestionId,
      status: input.status,
    },
    fetchImpl,
  );
}

export async function resolveDocsSuggestions(
  input: {
    readonly docId: string;
    readonly suggestionIds: readonly string[];
    readonly status: "accepted" | "rejected";
  },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<{ readonly suggestions: readonly DocsSuggestion[]; readonly count: number }> {
  return callDocsTool<{ readonly suggestions: readonly DocsSuggestion[]; readonly count: number }>(
    "docs.suggestion.resolve-batch",
    {
      docId: input.docId,
      suggestionIds: input.suggestionIds,
      status: input.status,
    },
    fetchImpl,
  );
}

export function docsSyncUrl(docId: string): string {
  const path = `/sync/docs/${encodeURIComponent(docId)}`;
  if (typeof window === "undefined") {
    return path;
  }

  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return addAccessTokenSearchParam(url.toString());
}

export function createDocsSyncClient(options: DocsSyncClientOptions): DocsSyncClient {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const socket = new WebSocketImpl(options.url ?? docsSyncUrl(options.docId));

  socket.addEventListener("open", () => options.onOpen?.());
  socket.addEventListener("close", () => options.onClose?.());
  socket.addEventListener("error", (event) => options.onError?.(event));
  socket.addEventListener("message", (event) => {
    const parsed = parseDocsSyncEvent(event.data);
    if (parsed !== null) {
      options.onEvent(parsed);
    }
  });

  return {
    sendUpdate: (input) => {
      socket.send(
        JSON.stringify({
          type: "update",
          updateBase64: input.updateBase64,
          ...(input.stateBase64 === undefined ? {} : { stateBase64: input.stateBase64 }),
          metadata: input.metadata ?? {},
        }),
      );
    },
    isOpen: () => socket.readyState === WebSocketImpl.OPEN,
    close: () => {
      socket.close();
    },
  };
}

async function callDocsTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: DocsApiFetch,
): Promise<Output> {
  // Shared callTool helper auto-approves pending_confirmation responses
  // (e.g. docs.delete) so the UI sees the executed output, not a silent
  // pending envelope.
  return callTool<Output>(toolId, input, { fetchImpl });
}

function docsAskHistoryItemFromOutput(item: DocsAskHistoryItem): DocsAskHistoryItem {
  const citations = Array.isArray(item.citations)
    ? item.citations.flatMap(docsAskCitationFromValue)
    : docsAskCitationsFromMetadata(item.metadata);
  return citations.length === 0 ? item : { ...item, citations };
}

function docsAskCitationsFromMetadata(
  metadata: Record<string, unknown>,
): readonly DocsAskCitation[] {
  const rawCitations = metadata.citations;
  return Array.isArray(rawCitations) ? rawCitations.flatMap(docsAskCitationFromValue) : [];
}

function docsAskCitationFromValue(value: unknown): readonly DocsAskCitation[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.label !== "string" ||
    typeof record.excerpt !== "string" ||
    (record.sourceScope !== "document" && record.sourceScope !== "selection")
  ) {
    return [];
  }
  const label = normalizedAskCitationText(record.label, 160);
  const excerpt = normalizedAskCitationText(record.excerpt, 500);
  if (label.length === 0 || excerpt.length === 0) {
    return [];
  }
  const selection = docsAskSelectionFromValue(record.selection);
  return [
    {
      label,
      excerpt,
      sourceScope: record.sourceScope,
      ...(selection === null ? {} : { selection }),
    },
  ];
}

function docsAskSelectionFromValue(value: unknown): DocsAskCitation["selection"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.from !== "number" ||
    typeof record.to !== "number" ||
    typeof record.text !== "string" ||
    !Number.isSafeInteger(record.from) ||
    !Number.isSafeInteger(record.to) ||
    record.to <= record.from
  ) {
    return null;
  }
  const text = normalizedAskCitationText(record.text, 50_000);
  return text.length === 0 ? null : { from: record.from, to: record.to, text };
}

function normalizedAskCitationText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function parseDocsSyncEvent(data: unknown): DocsSyncEvent | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) && typeof parsed.type === "string" ? (parsed as DocsSyncEvent) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  if (typeof output.error === "string") {
    return output.error;
  }
  if (isRecord(output.error) && typeof output.error.message === "string") {
    return output.error.message;
  }
  if (typeof output.message === "string") {
    return output.message;
  }
  return undefined;
}
