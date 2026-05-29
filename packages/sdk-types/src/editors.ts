import type { Actor, EventBus } from "./core.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { ToolDefinition } from "./tools.js";

export const EDITORS_CORE_APP_ID = "editors" as const;

export const EDITORS_ROLE_IDS = [
  "editors",
  "editors-conv-worker",
  "editors-export-worker",
  "editors-ocr-worker",
  "editors-collab-gw",
] as const;

export type EditorsRoleId = (typeof EDITORS_ROLE_IDS)[number];

export const EDITORS_OOXML_FIDELITY_MODES = ["native", "legacy"] as const;

export type EditorsOoxmlFidelityMode = (typeof EDITORS_OOXML_FIDELITY_MODES)[number];

export interface EditorsModuleRegistration {
  readonly routes: readonly string[];
  readonly tools: readonly string[];
  readonly workers: readonly string[];
  readonly previewRenderers: readonly string[];
  readonly aiSlots: readonly string[];
  readonly collabGateways: readonly string[];
  readonly ooxmlFidelityMode: EditorsOoxmlFidelityMode;
}

export interface EditorsHost {
  readonly role?: string;
  readonly apps?: readonly string[];
  readonly registerRoute?: (routeId: string) => void;
  readonly registerTool?: (toolId: string) => void;
  readonly registerWorker?: (workerId: string) => void;
  readonly registerPreviewRenderer?: (mimeType: string) => void;
  readonly registerAiSlot?: (slotId: string) => void;
  readonly registerCollabGateway?: (gatewayId: string) => void;
  readonly log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

export type EditorsMaybePromise<T> = T | Promise<T>;
export type EditorsHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EditorsHttpRequest {
  readonly method: EditorsHttpMethod;
  readonly url: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly params: Record<string, string>;
  readonly query: Record<string, string | readonly string[] | undefined>;
  readonly body?: unknown;
  readonly actor?: Actor;
  readonly orgId?: string;
  readonly traceId?: string;
}

export interface EditorsHttpReply {
  status(code: number): EditorsHttpReply;
  header(name: string, value: string): EditorsHttpReply;
  send(payload?: JsonValue | Uint8Array | string): EditorsMaybePromise<void>;
}

export interface EditorsHttpRoute {
  readonly method: EditorsHttpMethod;
  readonly path: string;
  readonly schema?: JsonObject;
  handler(request: EditorsHttpRequest, reply: EditorsHttpReply): EditorsMaybePromise<void>;
}

export interface EditorsWebSocket {
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: string | Uint8Array | ArrayBuffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface EditorsWebSocketRoute {
  readonly path: string;
  handler(socket: EditorsWebSocket, request: EditorsHttpRequest): EditorsMaybePromise<void>;
}

export interface EditorsDocumentSessionRequest {
  readonly actor: Actor;
  readonly orgId: string;
  readonly documentId: string;
}

export interface EditorsDocumentSession {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly ownerActorId: string | null;
  readonly editorEngine: string;
  readonly formatVersion: number;
  readonly updateSeq: number;
  readonly stateBase64: string | null;
  readonly stateVectorBase64: string | null;
  readonly layoutSettings?: EditorsDocumentLayoutSettings | undefined;
  readonly updatedAt: string;
}

export interface EditorsDocumentLayoutSettings {
  readonly layoutMode: "page" | "pageless";
  readonly columnCount: 1 | 2;
  readonly sections?: readonly EditorsDocumentSectionSettings[] | undefined;
}

export interface EditorsDocumentSectionSettings {
  readonly id: string;
  readonly title?: string | undefined;
  readonly layoutMode?: "page" | "pageless" | undefined;
  readonly columnCount?: 1 | 2 | undefined;
  readonly pageSize?: "letter" | "a4" | undefined;
  readonly orientation?: "portrait" | "landscape" | undefined;
}

export interface EditorsDocumentCapabilities {
  getSession(input: EditorsDocumentSessionRequest): EditorsMaybePromise<EditorsDocumentSession | null>;
}

export interface EditorsWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface HelixEditorsRuntimeHost extends EditorsHost {
  readonly tools?: { readonly register: (tool: ToolDefinition) => void };
  readonly http?: {
    readonly route: (route: EditorsHttpRoute) => void;
    readonly websocket?: (route: EditorsWebSocketRoute) => void;
  };
  readonly workers?: { readonly register: (name: string, worker: EditorsWorker) => void };
  readonly documents?: EditorsDocumentCapabilities;
  readonly metrics?: unknown;
  readonly events?: EventBus;
}

export interface RegisterEditorsModuleOptions {
  readonly enabled?: boolean;
  readonly enabledRoles?: readonly EditorsRoleId[];
  readonly ooxmlFidelityMode?: EditorsOoxmlFidelityMode;
  readonly registerPlaceholders?: boolean;
}

export type EditorsModuleRegistrar = (
  host: EditorsHost,
  options?: RegisterEditorsModuleOptions,
) => EditorsModuleRegistration | Promise<EditorsModuleRegistration>;

export type EditorsCoreAppRegistrar = (
  host: HelixEditorsRuntimeHost,
  options?: RegisterEditorsModuleOptions,
) => EditorsModuleRegistration | Promise<EditorsModuleRegistration>;

export interface EditorsCoreAppModule {
  readonly registerEditorsModule?: EditorsModuleRegistrar;
  readonly registerEditorsCoreApp?: EditorsCoreAppRegistrar;
  readonly resolveEditorsMigrationDir?: () => string;
  readonly getEditorsMigrationSource?: () => EditorsCoreAppMigrationSource;
}

export interface EditorsCoreAppMigrationSource {
  readonly namespace: "editors";
  readonly directory: string;
}
