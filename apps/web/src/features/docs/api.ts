import { addAccessTokenSearchParam, authenticatedFetch } from "@/lib/auth";

export type DocsApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DocsExportFormat = "markdown" | "pdf" | "docx";

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
  readonly metadata: Record<string, unknown>;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocsCreateInput {
  readonly title: string;
  readonly initialMarkdown?: string;
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
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly body: string;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export type DocsSuggestionStatus = "pending" | "accepted" | "rejected";

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

/**
 * A comment surfaced for the rail.
 *
 * Backend gap: the Docs platform exposes `docs.comment.create` but no
 * `docs.comment.list` tool — open comments are only retrievable through
 * `docs.export` with `includeComments: true`, which appends a `## Comments`
 * section (`- Author: body`). {@link listDocsComments} parses that section so
 * the rail can render real backend comments until a list tool ships.
 */
export interface DocsCommentSummary {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

export async function listDocsComments(
  input: { readonly docId: string },
  fetchImpl: DocsApiFetch = authenticatedFetch,
): Promise<readonly DocsCommentSummary[]> {
  const exported = await exportDocsDocument(
    { docId: input.docId, format: "markdown", includeComments: true },
    fetchImpl,
  );
  return parseExportedComments(exported.text ?? decodeBase64Text(exported.contentBase64));
}

function decodeBase64Text(value: string): string {
  try {
    return typeof atob === "function"
      ? atob(value)
      : Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Pulls `- Author: body` lines out of an exported doc's `## Comments` block. */
export function parseExportedComments(markdown: string): readonly DocsCommentSummary[] {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+Comments\s*$/u.test(line));
  if (start === -1) {
    return [];
  }
  const comments: DocsCommentSummary[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s/u.test(line)) {
      break;
    }
    const match = /^-\s+(.+?):\s+([\s\S]*)$/u.exec(line.trim());
    if (match !== null) {
      comments.push({
        id: `comment-${String(index)}`,
        author: match[1] ?? "Unknown",
        body: match[2] ?? "",
      });
    }
  }
  return comments;
}

export async function createDocsComment(
  input: {
    readonly docId: string;
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
      body: input.body,
      anchor: input.anchor ?? {},
      metadata: input.metadata ?? {},
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
    close: () => socket.close(),
  };
}

async function callDocsTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: DocsApiFetch,
): Promise<Output> {
  const response = await fetchImpl(`/api/tools/${toolId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `${toolId} failed with ${String(response.status)}`,
    );
  }

  return output as Output;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
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
