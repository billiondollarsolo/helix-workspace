import type { EventEnvelope } from "./core.js";
import type { JsonObject } from "./json.js";

export interface IndexDocument {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly attributes?: JsonObject;
}

export interface IndexerDefinition {
  readonly id: string;
  readonly entityType: string;
  readonly subjects: readonly string[];
  project(event: EventEnvelope, host: unknown): Promise<IndexDocument | null>;
}

export interface NotificationSource {
  readonly id: string;
  readonly templates: Record<string, string>;
  readonly preferences?: JsonObject;
}

export interface ScheduledJobDefinition {
  readonly id: string;
  readonly schedule: string;
  readonly leaderOnly: boolean;
  handler(host: unknown): Promise<void>;
}

export interface SMTPListenerOpts {
  readonly ports: readonly number[];
  readonly hostname: string;
  readonly tls?: JsonObject;
  readonly auth?: "none" | "required" | "optional";
}

export type ConsumerHandler = (event: EventEnvelope) => Promise<void>;
export type SMTPHandler = (message: AsyncIterable<Uint8Array>) => Promise<void>;
export type SlotProvider = (context: JsonObject) => Promise<JsonObject>;
export type EnrichmentHandler = (input: JsonObject) => Promise<JsonObject>;
export type RESTHandler = (request: unknown) => Promise<Response>;
export type WSHandler = (socket: unknown) => void;
export type TRPCRouter = unknown;
