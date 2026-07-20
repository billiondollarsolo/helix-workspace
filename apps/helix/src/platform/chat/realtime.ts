import type { Actor, EventBus, JsonObject, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { ChatPresenceStatus } from "./types.js";

export type ChatRoomEvent = JsonObject & {
  readonly type: string;
  readonly roomId: string;
  readonly actorId?: string;
};

export interface ChatRoomBus {
  publish(roomId: string, event: ChatRoomEvent): Promise<void>;
  subscribe(roomId: string, handler: (event: ChatRoomEvent) => Promise<void>): Promise<Unsubscribe>;
}

export type PresenceEntry = JsonObject & {
  readonly actorId: string;
  readonly orgId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly status: ChatPresenceStatus;
  readonly seenAt: string;
};

export interface ChatPresenceTouchInput {
  readonly roomId: string;
  readonly actor: Actor;
  readonly at?: Date;
  readonly status?: ChatPresenceStatus;
}

export interface ChatPresenceStore {
  touch(input: ChatPresenceTouchInput): Promise<PresenceEntry>;
  remove(input: { readonly roomId: string; readonly actorId: string }): Promise<void>;
  list(roomId: string): Promise<readonly PresenceEntry[]>;
}

export interface RedisPresenceClient {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface ChatPresenceOptions {
  readonly keyPrefix?: string;
  readonly ttlSeconds?: number;
  /**
   * Fraction of TTL after which an idle (not refreshed) entry is reported as
   * `away` rather than its declared status. Default 0.5.
   */
  readonly awayThresholdFraction?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export class EventBusChatRoomBus implements ChatRoomBus {
  constructor(
    private readonly eventBus: EventBus,
    private readonly options: { readonly subjectPrefix?: string } = {},
  ) {}

  async publish(roomId: string, event: ChatRoomEvent): Promise<void> {
    await this.eventBus.publish(roomSubject(roomId, this.options.subjectPrefix), event);
  }

  async subscribe(roomId: string, handler: (event: ChatRoomEvent) => Promise<void>): Promise<Unsubscribe> {
    return this.eventBus.subscribe(roomSubject(roomId, this.options.subjectPrefix), async (event) => {
      if (isChatRoomEvent(event.payload)) {
        await handler(event.payload);
      }
    });
  }
}

export class InMemoryChatRoomBus implements ChatRoomBus {
  readonly #handlers = new Map<string, Set<(event: ChatRoomEvent) => Promise<void>>>();

  async publish(roomId: string, event: ChatRoomEvent): Promise<void> {
    const handlers = [...(this.#handlers.get(roomId) ?? [])];
    await Promise.all(handlers.map((handler) => handler(event)));
  }

  async subscribe(roomId: string, handler: (event: ChatRoomEvent) => Promise<void>): Promise<Unsubscribe> {
    const handlers = this.#handlers.get(roomId) ?? new Set<(event: ChatRoomEvent) => Promise<void>>();
    handlers.add(handler);
    this.#handlers.set(roomId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.#handlers.delete(roomId);
      }
    };
  }
}

export class RedisChatPresenceStore implements ChatPresenceStore {
  readonly #keyPrefix: string;
  readonly #ttlSeconds: number;
  readonly #awayThresholdMs: number;
  readonly #now: () => number;

  constructor(
    private readonly redis: RedisPresenceClient,
    options: ChatPresenceOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:chat:presence";
    this.#ttlSeconds = options.ttlSeconds ?? 45;
    this.#awayThresholdMs =
      this.#ttlSeconds * 1000 * (options.awayThresholdFraction ?? 0.5);
    this.#now = options.now ?? Date.now;
  }

  async touch(input: ChatPresenceTouchInput): Promise<PresenceEntry> {
    const entry = presenceEntry(input.actor, input.at ?? new Date(), input.status ?? "available");
    await this.redis.set(this.#actorKey(input.roomId, input.actor.id), JSON.stringify(entry), "EX", this.#ttlSeconds);
    await this.redis.sadd(this.#roomKey(input.roomId), input.actor.id);
    await this.redis.expire(this.#roomKey(input.roomId), this.#ttlSeconds * 2);
    return entry;
  }

  async remove(input: { readonly roomId: string; readonly actorId: string }): Promise<void> {
    await this.redis.del(this.#actorKey(input.roomId, input.actorId));
    await this.redis.srem(this.#roomKey(input.roomId), input.actorId);
  }

  async list(roomId: string): Promise<readonly PresenceEntry[]> {
    const actorIds = await this.redis.smembers(this.#roomKey(roomId));
    const entries: PresenceEntry[] = [];
    const now = this.#now();
    await Promise.all(actorIds.map(async (actorId) => {
      const raw = await this.redis.get(this.#actorKey(roomId, actorId));
      if (raw === null) {
        await this.redis.srem(this.#roomKey(roomId), actorId);
        return;
      }
      const parsed = safePresenceEntry(raw);
      if (parsed !== null) {
        entries.push(applyAwayThreshold(parsed, now, this.#awayThresholdMs));
      }
    }));
    return entries.sort((left, right) => left.actorId.localeCompare(right.actorId));
  }

  #roomKey(roomId: string): string {
    return `${this.#keyPrefix}:${keyPart(roomId)}:actors`;
  }

  #actorKey(roomId: string, actorId: string): string {
    return `${this.#keyPrefix}:${keyPart(roomId)}:${keyPart(actorId)}`;
  }
}

export class InMemoryChatPresenceStore implements ChatPresenceStore {
  readonly #ttlMs: number;
  readonly #awayThresholdMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, PresenceEntry>();

  constructor(options: ChatPresenceOptions = {}) {
    this.#ttlMs = (options.ttlSeconds ?? 45) * 1000;
    this.#awayThresholdMs = this.#ttlMs * (options.awayThresholdFraction ?? 0.5);
    this.#now = options.now ?? Date.now;
  }

  async touch(input: ChatPresenceTouchInput): Promise<PresenceEntry> {
    const entry = presenceEntry(input.actor, input.at ?? new Date(), input.status ?? "available");
    this.#entries.set(memoryKey(input.roomId, input.actor.id), entry);
    return entry;
  }

  async remove(input: { readonly roomId: string; readonly actorId: string }): Promise<void> {
    this.#entries.delete(memoryKey(input.roomId, input.actorId));
  }

  async list(roomId: string): Promise<readonly PresenceEntry[]> {
    const now = this.#now();
    const entries: PresenceEntry[] = [];
    for (const [key, entry] of this.#entries.entries()) {
      if (!key.startsWith(`${roomId}:`)) {
        continue;
      }
      if (Date.parse(entry.seenAt) + this.#ttlMs <= now) {
        this.#entries.delete(key);
        continue;
      }
      entries.push(applyAwayThreshold(entry, now, this.#awayThresholdMs));
    }
    return entries.sort((left, right) => left.actorId.localeCompare(right.actorId));
  }
}

export function roomSubject(roomId: string, prefix = "chat.room"): string {
  return `${prefix}.${keyPart(roomId)}.events`;
}

function presenceEntry(
  actor: Actor,
  at: Date,
  status: ChatPresenceStatus,
): PresenceEntry {
  const effective: ChatPresenceStatus = status === "offline" ? "available" : status;
  return {
    actorId: actor.id,
    orgId: actor.orgId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    ...(actor.email === undefined ? {} : { email: actor.email }),
    status: effective,
    seenAt: at.toISOString(),
  };
}

/**
 * Idle (not refreshed past away threshold) non-busy entries report `away`.
 * Explicit `busy` is honored until TTL expiry.
 */
function applyAwayThreshold(
  entry: PresenceEntry,
  nowMs: number,
  awayThresholdMs: number,
): PresenceEntry {
  if (entry.status === "busy" || entry.status === "offline") {
    return entry;
  }
  const seenMs = Date.parse(entry.seenAt);
  if (!Number.isFinite(seenMs)) {
    return entry;
  }
  if (nowMs - seenMs >= awayThresholdMs) {
    return { ...entry, status: "away" };
  }
  return entry;
}

const PRESENCE_STATUSES = new Set<string>(["available", "away", "busy", "offline", "online"]);

function safePresenceEntry(raw: string): PresenceEntry | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { readonly actorId?: unknown }).actorId === "string" &&
      typeof (parsed as { readonly orgId?: unknown }).orgId === "string" &&
      typeof (parsed as { readonly status?: unknown }).status === "string" &&
      PRESENCE_STATUSES.has((parsed as { readonly status: string }).status) &&
      typeof (parsed as { readonly seenAt?: unknown }).seenAt === "string"
    ) {
      const status = (parsed as { readonly status: string }).status;
      // Legacy "online" → available
      const normalized: ChatPresenceStatus =
        status === "online"
          ? "available"
          : (status as ChatPresenceStatus);
      return {
        ...(parsed as PresenceEntry),
        status: normalized,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isChatRoomEvent(value: JsonValue): value is ChatRoomEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly type?: unknown }).type === "string" &&
    typeof (value as { readonly roomId?: unknown }).roomId === "string"
  );
}

function keyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function memoryKey(roomId: string, actorId: string): string {
  return `${roomId}:${actorId}`;
}
