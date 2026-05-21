import type { Actor, EventBus, JsonObject, JsonValue, Unsubscribe } from "@helix/sdk-types";

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
  readonly status: "online";
  readonly seenAt: string;
};

export interface ChatPresenceStore {
  touch(input: { readonly roomId: string; readonly actor: Actor; readonly at?: Date }): Promise<PresenceEntry>;
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

  constructor(
    private readonly redis: RedisPresenceClient,
    options: ChatPresenceOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:chat:presence";
    this.#ttlSeconds = options.ttlSeconds ?? 45;
  }

  async touch(input: { readonly roomId: string; readonly actor: Actor; readonly at?: Date }): Promise<PresenceEntry> {
    const entry = presenceEntry(input.actor, input.at ?? new Date());
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
    await Promise.all(actorIds.map(async (actorId) => {
      const raw = await this.redis.get(this.#actorKey(roomId, actorId));
      if (raw === null) {
        await this.redis.srem(this.#roomKey(roomId), actorId);
        return;
      }
      const parsed = safePresenceEntry(raw);
      if (parsed !== null) {
        entries.push(parsed);
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
  readonly #entries = new Map<string, PresenceEntry>();

  constructor(options: ChatPresenceOptions = {}) {
    this.#ttlMs = (options.ttlSeconds ?? 45) * 1000;
  }

  async touch(input: { readonly roomId: string; readonly actor: Actor; readonly at?: Date }): Promise<PresenceEntry> {
    const entry = presenceEntry(input.actor, input.at ?? new Date());
    this.#entries.set(memoryKey(input.roomId, input.actor.id), entry);
    return entry;
  }

  async remove(input: { readonly roomId: string; readonly actorId: string }): Promise<void> {
    this.#entries.delete(memoryKey(input.roomId, input.actorId));
  }

  async list(roomId: string): Promise<readonly PresenceEntry[]> {
    const now = Date.now();
    const entries: PresenceEntry[] = [];
    for (const [key, entry] of this.#entries.entries()) {
      if (!key.startsWith(`${roomId}:`)) {
        continue;
      }
      if (Date.parse(entry.seenAt) + this.#ttlMs <= now) {
        this.#entries.delete(key);
        continue;
      }
      entries.push(entry);
    }
    return entries.sort((left, right) => left.actorId.localeCompare(right.actorId));
  }
}

export function roomSubject(roomId: string, prefix = "chat.room"): string {
  return `${prefix}.${keyPart(roomId)}.events`;
}

function presenceEntry(actor: Actor, at: Date): PresenceEntry {
  return {
    actorId: actor.id,
    orgId: actor.orgId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    ...(actor.email === undefined ? {} : { email: actor.email }),
    status: "online",
    seenAt: at.toISOString(),
  };
}

function safePresenceEntry(raw: string): PresenceEntry | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { readonly actorId?: unknown }).actorId === "string" &&
      typeof (parsed as { readonly orgId?: unknown }).orgId === "string" &&
      (parsed as { readonly status?: unknown }).status === "online" &&
      typeof (parsed as { readonly seenAt?: unknown }).seenAt === "string"
    ) {
      return parsed as PresenceEntry;
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
