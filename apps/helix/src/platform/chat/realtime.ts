import type { Actor, EventBus, JsonObject, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { ChatPresenceStatus } from "./types.js";

export type ChatRoomEvent = JsonObject & {
  readonly type: string;
  readonly roomId: string;
  readonly orgId: string;
  readonly actorId?: string;
};

export type SequencedChatRoomEvent = ChatRoomEvent & { readonly cursor: number };

export interface ChatRoomReplayInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly roomId: string;
  readonly after: number;
  readonly limit: number;
}

export interface ChatRoomReplayResult {
  readonly authorized: boolean;
  readonly events: readonly SequencedChatRoomEvent[];
  readonly cursor: number;
  readonly latestCursor: number;
  readonly hasMore: boolean;
  readonly resetRequired: boolean;
}

export interface ChatRoomEventLog {
  append(event: ChatRoomEvent): Promise<SequencedChatRoomEvent>;
  replay(input: ChatRoomReplayInput): Promise<ChatRoomReplayResult>;
}

export interface ChatRoomBus {
  publish(orgId: string, roomId: string, event: ChatRoomEvent): Promise<void>;
  subscribe(
    orgId: string,
    roomId: string,
    handler: (event: ChatRoomEvent) => Promise<void>,
  ): Promise<Unsubscribe>;
  replay(input: ChatRoomReplayInput): Promise<ChatRoomReplayResult>;
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
  readonly connectionId?: string;
  readonly at?: Date;
  readonly status?: ChatPresenceStatus;
}

export interface ChatPresenceStore {
  connect(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly connectionId: string;
    readonly limit: number;
  }): Promise<boolean>;
  disconnect(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly connectionId: string;
  }): Promise<void>;
  touch(input: ChatPresenceTouchInput): Promise<PresenceEntry>;
  remove(input: {
    readonly roomId: string;
    readonly actorId: string;
    readonly connectionId?: string;
  }): Promise<void>;
  list(roomId: string): Promise<readonly PresenceEntry[]>;
}

export interface RedisPresenceClient {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  sscan(
    key: string,
    cursor: string,
    mode: "COUNT",
    count: number,
  ): Promise<[cursor: string, members: string[]]>;
  expire(key: string, seconds: number): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: readonly (string | number)[]): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
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
  readonly maxRosterSize?: number;
}

export class EventBusChatRoomBus implements ChatRoomBus {
  readonly #events: ChatRoomEventLog;

  constructor(
    private readonly eventBus: EventBus,
    private readonly options: {
      readonly subjectPrefix?: string;
      readonly events: ChatRoomEventLog;
      readonly maxPendingEvents?: number;
      readonly onSlowConsumer?: (input: {
        readonly orgId: string;
        readonly roomId: string;
      }) => void;
      readonly onError?: (error: unknown) => void;
      readonly metrics?:
        | {
            recordOperationalEvent(input: {
              readonly capability: "chat";
              readonly operation: "fanout" | "replay";
              readonly status: "success" | "error" | "retry" | "blocked" | "dry_run";
              readonly durationSeconds?: number;
            }): void;
            addOperationalUnits(input: {
              readonly capability: "chat";
              readonly measure: "replayed_events";
              readonly value?: number;
            }): void;
          }
        | undefined;
    },
  ) {
    this.#events = options.events;
  }

  async publish(orgId: string, roomId: string, event: ChatRoomEvent): Promise<void> {
    const startedAt = Date.now();
    assertRoomEvent(orgId, roomId, event);
    // Stored cursors already have a transactional outbox entry. Publishing here
    // could beat the HTTP commit and make subscribers replay an invisible event.
    if (isDurableChatRoomEvent(event) && isSequencedChatRoomEvent(event)) return;
    const published =
      isDurableChatRoomEvent(event) && !isSequencedChatRoomEvent(event)
        ? await this.#events.append(event)
        : event;
    try {
      await this.eventBus.publish(
        roomSubject(orgId, roomId, this.options.subjectPrefix),
        published,
      );
      this.record("fanout", "success", startedAt);
    } catch (error) {
      this.record("fanout", "error", startedAt);
      throw error;
    }
  }

  async subscribe(
    orgId: string,
    roomId: string,
    handler: (event: ChatRoomEvent) => Promise<void>,
  ): Promise<Unsubscribe> {
    const delivery = createOrderedDelivery(
      handler,
      positiveInteger(this.options.maxPendingEvents ?? 256),
      () => this.options.onSlowConsumer?.({ orgId, roomId }),
      this.options.onError,
    );
    const unsubscribe = await this.eventBus.subscribe(
      roomSubject(orgId, roomId, this.options.subjectPrefix),
      async (event) => {
        if (
          isChatRoomEvent(event.payload) &&
          event.payload.orgId === orgId &&
          event.payload.roomId === roomId
        )
          delivery.accept(event.payload);
      },
    );
    return async () => {
      await unsubscribe();
      await delivery.drain();
    };
  }

  async replay(input: ChatRoomReplayInput): Promise<ChatRoomReplayResult> {
    const startedAt = Date.now();
    try {
      const result = await this.#events.replay(input);
      this.record("replay", result.authorized ? "success" : "blocked", startedAt);
      this.options.metrics?.addOperationalUnits({
        capability: "chat",
        measure: "replayed_events",
        value: result.events.length,
      });
      return result;
    } catch (error) {
      this.record("replay", "error", startedAt);
      throw error;
    }
  }

  private record(
    operation: "fanout" | "replay",
    status: "success" | "error" | "blocked",
    startedAt: number,
  ): void {
    this.options.metrics?.recordOperationalEvent({
      capability: "chat",
      operation,
      status,
      durationSeconds: (Date.now() - startedAt) / 1_000,
    });
  }
}

interface OrderedDelivery {
  accept(event: ChatRoomEvent): void;
  drain(): Promise<void>;
}

function createOrderedDelivery(
  handler: (event: ChatRoomEvent) => Promise<void>,
  maxPendingEvents: number,
  onSlowConsumer: () => void,
  onError: ((error: unknown) => void) | undefined,
): OrderedDelivery {
  let pending = 0;
  let tail = Promise.resolve();
  const recentEventIds = new Set<string>();
  const recentOrder: string[] = [];
  return {
    accept(event) {
      const eventId =
        typeof event.eventId === "string"
          ? event.eventId
          : typeof event.cursor === "number"
            ? `${event.orgId}:${event.roomId}:${String(event.cursor)}`
            : undefined;
      if (eventId !== undefined && recentEventIds.has(eventId)) return;
      if (pending >= maxPendingEvents) {
        onSlowConsumer();
        return;
      }
      if (eventId !== undefined) {
        recentEventIds.add(eventId);
        recentOrder.push(eventId);
      }
      if (recentOrder.length > 4_096) {
        const oldest = recentOrder.shift();
        if (oldest !== undefined) recentEventIds.delete(oldest);
      }
      pending += 1;
      tail = tail
        .catch((error: unknown) => {
          onError?.(error);
        })
        .then(() => handler(event))
        .catch((error: unknown) => {
          onError?.(error);
        })
        .finally(() => {
          pending -= 1;
        });
    },
    async drain() {
      await tail;
    },
  };
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Chat maxPendingEvents must be a positive integer.");
  }
  return value;
}

export class InMemoryChatRoomBus implements ChatRoomBus {
  readonly #handlers = new Map<string, Set<(event: ChatRoomEvent) => Promise<void>>>();
  readonly #events = new InMemoryChatRoomEventLog();

  async publish(orgId: string, roomId: string, event: ChatRoomEvent): Promise<void> {
    assertRoomEvent(orgId, roomId, event);
    const published =
      isDurableChatRoomEvent(event) && !isSequencedChatRoomEvent(event)
        ? await this.#events.append(event)
        : event;
    const handlers = [...(this.#handlers.get(eventLogKey(orgId, roomId)) ?? [])];
    await Promise.all(handlers.map((handler) => handler(published)));
  }

  async subscribe(
    orgId: string,
    roomId: string,
    handler: (event: ChatRoomEvent) => Promise<void>,
  ): Promise<Unsubscribe> {
    const handlers =
      this.#handlers.get(eventLogKey(orgId, roomId)) ??
      new Set<(event: ChatRoomEvent) => Promise<void>>();
    handlers.add(handler);
    this.#handlers.set(eventLogKey(orgId, roomId), handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.#handlers.delete(eventLogKey(orgId, roomId));
      }
    };
  }

  replay(input: ChatRoomReplayInput): Promise<ChatRoomReplayResult> {
    return this.#events.replay(input);
  }
}

export class InMemoryChatRoomEventLog implements ChatRoomEventLog {
  readonly #events = new Map<string, SequencedChatRoomEvent[]>();

  async append(event: ChatRoomEvent): Promise<SequencedChatRoomEvent> {
    const key = eventLogKey(event.orgId, event.roomId);
    const roomEvents = this.#events.get(key) ?? [];
    const stored: SequencedChatRoomEvent = { ...event, cursor: roomEvents.length + 1 };
    roomEvents.push(stored);
    this.#events.set(key, roomEvents);
    return stored;
  }

  async replay(input: ChatRoomReplayInput): Promise<ChatRoomReplayResult> {
    const roomEvents = this.#events.get(eventLogKey(input.orgId, input.roomId)) ?? [];
    const latestCursor = roomEvents.length;
    const resetRequired = input.after > latestCursor;
    const events = resetRequired
      ? []
      : roomEvents.filter((event) => event.cursor > input.after).slice(0, input.limit);
    return {
      authorized: true,
      events,
      cursor: events.at(-1)?.cursor ?? input.after,
      latestCursor,
      hasMore: (events.at(-1)?.cursor ?? input.after) < latestCursor && !resetRequired,
      resetRequired,
    };
  }
}

export function isDurableChatRoomEvent(event: ChatRoomEvent): boolean {
  return (
    event.type === "read" || event.type === "access.changed" || event.type.startsWith("message.")
  );
}

function isSequencedChatRoomEvent(event: ChatRoomEvent): event is SequencedChatRoomEvent {
  return typeof event.cursor === "number" && Number.isSafeInteger(event.cursor) && event.cursor > 0;
}

function assertRoomEvent(orgId: string, roomId: string, event: ChatRoomEvent): void {
  if (event.orgId !== orgId || event.roomId !== roomId) {
    throw new TypeError("Chat event room does not match its subject.");
  }
}

function eventLogKey(orgId: string, roomId: string): string {
  return `${orgId}:${roomId}`;
}

const REDIS_CONNECT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
`;

export class RedisChatPresenceStore implements ChatPresenceStore {
  readonly #keyPrefix: string;
  readonly #ttlSeconds: number;
  readonly #awayThresholdMs: number;
  readonly #now: () => number;
  readonly #maxRosterSize: number;

  constructor(
    private readonly redis: RedisPresenceClient,
    options: ChatPresenceOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:chat:presence";
    this.#ttlSeconds = options.ttlSeconds ?? 45;
    this.#awayThresholdMs = this.#ttlSeconds * 1000 * (options.awayThresholdFraction ?? 0.5);
    this.#now = options.now ?? Date.now;
    this.#maxRosterSize = Math.min(5_000, Math.max(1, Math.trunc(options.maxRosterSize ?? 500)));
  }

  async connect(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly connectionId: string;
    readonly limit: number;
  }): Promise<boolean> {
    const now = this.#now();
    const result = await this.redis.eval(
      REDIS_CONNECT_SCRIPT,
      1,
      this.#connectionKey(input.orgId, input.actorId),
      now,
      now + this.#ttlSeconds * 2_000,
      input.connectionId,
      input.limit,
      this.#ttlSeconds * 2,
    );
    return Number(result) === 1;
  }

  async disconnect(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly connectionId: string;
  }): Promise<void> {
    await this.redis.zrem(this.#connectionKey(input.orgId, input.actorId), input.connectionId);
  }

  async touch(input: ChatPresenceTouchInput): Promise<PresenceEntry> {
    const entry = presenceEntry(
      input.actor,
      input.at ?? new Date(this.#now()),
      input.status ?? "available",
    );
    const connectionId = input.connectionId ?? "default";
    await this.redis.set(
      this.#deviceKey(input.roomId, input.actor.id, connectionId),
      JSON.stringify(entry),
      "EX",
      this.#ttlSeconds,
    );
    await this.redis.sadd(this.#actorKey(input.roomId, input.actor.id), connectionId);
    await this.redis.expire(this.#actorKey(input.roomId, input.actor.id), this.#ttlSeconds * 2);
    await this.redis.sadd(this.#roomKey(input.roomId), input.actor.id);
    await this.redis.expire(this.#roomKey(input.roomId), this.#ttlSeconds * 2);
    return entry;
  }

  async remove(input: {
    readonly roomId: string;
    readonly actorId: string;
    readonly connectionId?: string;
  }): Promise<void> {
    const deviceIds =
      input.connectionId === undefined
        ? await this.redis.smembers(this.#actorKey(input.roomId, input.actorId))
        : [input.connectionId];
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        await this.redis.del(this.#deviceKey(input.roomId, input.actorId, deviceId));
        await this.redis.srem(this.#actorKey(input.roomId, input.actorId), deviceId);
      }),
    );
    if ((await this.redis.smembers(this.#actorKey(input.roomId, input.actorId))).length === 0) {
      await this.redis.srem(this.#roomKey(input.roomId), input.actorId);
    }
  }

  async list(roomId: string): Promise<readonly PresenceEntry[]> {
    const actorIds = await scanSet(this.redis, this.#roomKey(roomId), this.#maxRosterSize);
    const entries: PresenceEntry[] = [];
    const now = this.#now();
    await Promise.all(
      actorIds.map(async (actorId) => {
        const deviceSetKey = this.#actorKey(roomId, actorId);
        const deviceIds = await this.redis.smembers(deviceSetKey);
        const deviceEntries: PresenceEntry[] = [];
        await Promise.all(
          deviceIds.map(async (deviceId) => {
            const raw = await this.redis.get(this.#deviceKey(roomId, actorId, deviceId));
            const parsed = raw === null ? null : safePresenceEntry(raw);
            if (parsed === null) {
              await this.redis.srem(deviceSetKey, deviceId);
            } else {
              deviceEntries.push(applyAwayThreshold(parsed, now, this.#awayThresholdMs));
            }
          }),
        );
        const entry = aggregatePresence(deviceEntries);
        if (entry === null) {
          if (deviceEntries.length === 0) await this.redis.srem(this.#roomKey(roomId), actorId);
        } else {
          entries.push(entry);
        }
      }),
    );
    return entries.sort((left, right) => left.actorId.localeCompare(right.actorId));
  }

  #roomKey(roomId: string): string {
    return `${this.#keyPrefix}:${keyPart(roomId)}:actors`;
  }

  #actorKey(roomId: string, actorId: string): string {
    return `${this.#keyPrefix}:${keyPart(roomId)}:${keyPart(actorId)}`;
  }

  #deviceKey(roomId: string, actorId: string, connectionId: string): string {
    return `${this.#actorKey(roomId, actorId)}:${keyPart(connectionId)}`;
  }

  #connectionKey(orgId: string, actorId: string): string {
    return `${this.#keyPrefix}:connections:${keyPart(orgId)}:${keyPart(actorId)}`;
  }
}

export class InMemoryChatPresenceStore implements ChatPresenceStore {
  readonly #ttlMs: number;
  readonly #awayThresholdMs: number;
  readonly #now: () => number;
  readonly #maxRosterSize: number;
  readonly #entries = new Map<string, PresenceEntry>();
  readonly #connections = new Map<string, Map<string, number>>();

  constructor(options: ChatPresenceOptions = {}) {
    this.#ttlMs = (options.ttlSeconds ?? 45) * 1000;
    this.#awayThresholdMs = this.#ttlMs * (options.awayThresholdFraction ?? 0.5);
    this.#now = options.now ?? Date.now;
    this.#maxRosterSize = Math.min(5_000, Math.max(1, Math.trunc(options.maxRosterSize ?? 500)));
  }

  async connect(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly connectionId: string;
    readonly limit: number;
  }): Promise<boolean> {
    const key = `${input.orgId}:${input.actorId}`;
    const now = this.#now();
    const connections = this.#connections.get(key) ?? new Map<string, number>();
    for (const [connectionId, expiresAt] of connections) {
      if (expiresAt <= now) connections.delete(connectionId);
    }
    if (!connections.has(input.connectionId) && connections.size >= input.limit) return false;
    connections.set(input.connectionId, now + this.#ttlMs * 2);
    this.#connections.set(key, connections);
    return true;
  }

  async disconnect(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly connectionId: string;
  }): Promise<void> {
    this.#connections.get(`${input.orgId}:${input.actorId}`)?.delete(input.connectionId);
  }

  async touch(input: ChatPresenceTouchInput): Promise<PresenceEntry> {
    const entry = presenceEntry(
      input.actor,
      input.at ?? new Date(this.#now()),
      input.status ?? "available",
    );
    this.#entries.set(memoryKey(input.roomId, input.actor.id, input.connectionId), entry);
    return entry;
  }

  async remove(input: {
    readonly roomId: string;
    readonly actorId: string;
    readonly connectionId?: string;
  }): Promise<void> {
    if (input.connectionId !== undefined) {
      this.#entries.delete(memoryKey(input.roomId, input.actorId, input.connectionId));
      return;
    }
    for (const key of this.#entries.keys()) {
      if (key.startsWith(`${input.roomId}:${input.actorId}:`)) this.#entries.delete(key);
    }
  }

  async list(roomId: string): Promise<readonly PresenceEntry[]> {
    const now = this.#now();
    const byActor = new Map<string, PresenceEntry[]>();
    for (const [key, entry] of this.#entries.entries()) {
      if (!key.startsWith(`${roomId}:`)) {
        continue;
      }
      if (Date.parse(entry.seenAt) + this.#ttlMs <= now) {
        this.#entries.delete(key);
        continue;
      }
      const actorEntries = byActor.get(entry.actorId) ?? [];
      actorEntries.push(applyAwayThreshold(entry, now, this.#awayThresholdMs));
      byActor.set(entry.actorId, actorEntries);
    }
    const entries = [...byActor.values()]
      .map(aggregatePresence)
      .filter((entry): entry is PresenceEntry => entry !== null);
    return entries
      .sort((left, right) => left.actorId.localeCompare(right.actorId))
      .slice(0, this.#maxRosterSize);
  }
}

export function roomSubject(orgId: string, roomId: string, prefix = "chat"): string {
  return `${prefix}.org.${keyPart(orgId)}.room.${keyPart(roomId)}.events`;
}

function presenceEntry(actor: Actor, at: Date, status: ChatPresenceStatus): PresenceEntry {
  return {
    actorId: actor.id,
    orgId: actor.orgId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    ...(actor.email === undefined ? {} : { email: actor.email }),
    status,
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
  if (entry.status === "busy" || entry.status === "dnd" || entry.status === "invisible") {
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

function aggregatePresence(entries: readonly PresenceEntry[]): PresenceEntry | null {
  if (entries.length === 0 || entries.some((entry) => entry.status === "invisible")) return null;
  const latest = entries.reduce((left, right) =>
    Date.parse(left.seenAt) >= Date.parse(right.seenAt) ? left : right,
  );
  const status: ChatPresenceStatus = entries.some((entry) => entry.status === "dnd")
    ? "dnd"
    : entries.some((entry) => entry.status === "busy")
      ? "busy"
      : entries.some((entry) => entry.status === "available")
        ? "available"
        : "away";
  return { ...latest, status };
}

async function scanSet(
  redis: RedisPresenceClient,
  key: string,
  limit: number,
): Promise<readonly string[]> {
  const members = new Set<string>();
  let cursor = "0";
  do {
    const page = await redis.sscan(key, cursor, "COUNT", limit);
    cursor = page[0];
    for (const member of page[1]) {
      members.add(member);
      if (members.size >= limit) return [...members];
    }
  } while (cursor !== "0");
  return [...members];
}

const PRESENCE_STATUSES = new Set<string>(["available", "away", "busy", "dnd", "invisible"]);

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
      return {
        ...(parsed as PresenceEntry),
        status: (parsed as { readonly status: ChatPresenceStatus }).status,
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
    typeof (value as { readonly roomId?: unknown }).roomId === "string" &&
    typeof (value as { readonly orgId?: unknown }).orgId === "string" &&
    ((value as { readonly cursor?: unknown }).cursor === undefined ||
      (typeof (value as { readonly cursor?: unknown }).cursor === "number" &&
        Number.isSafeInteger((value as { readonly cursor: number }).cursor) &&
        (value as { readonly cursor: number }).cursor > 0))
  );
}

function keyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function memoryKey(roomId: string, actorId: string, connectionId = "default"): string {
  return `${roomId}:${actorId}:${connectionId}`;
}
