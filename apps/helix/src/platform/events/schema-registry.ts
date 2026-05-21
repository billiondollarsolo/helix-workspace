import type { JsonObject } from "@helix/sdk-types";

export type EventDirection = "publish" | "subscribe" | "both";

export interface EventSchemaDefinition {
  readonly id: string;
  readonly subject: string;
  readonly title?: string;
  readonly description?: string;
  readonly payloadSchema: JsonObject;
  readonly headersSchema?: JsonObject;
  readonly direction?: EventDirection;
  readonly tags?: readonly string[];
}

export interface EventSchemaRegistry {
  register(event: EventSchemaDefinition): void;
  unregister(eventId: string): void;
  get(eventId: string): EventSchemaDefinition | undefined;
  getBySubject(subject: string): EventSchemaDefinition | undefined;
  list(): readonly EventSchemaDefinition[];
}

export class InMemoryEventSchemaRegistry implements EventSchemaRegistry {
  readonly #events = new Map<string, EventSchemaDefinition>();
  readonly #subjects = new Map<string, string>();

  register(event: EventSchemaDefinition): void {
    const normalized = normalizeEventSchemaDefinition(event);
    if (this.#events.has(normalized.id)) {
      throw new Error(`Event schema already registered: ${normalized.id}`);
    }
    if (this.#subjects.has(normalized.subject)) {
      throw new Error(`Event subject already registered: ${normalized.subject}`);
    }

    this.#events.set(normalized.id, normalized);
    this.#subjects.set(normalized.subject, normalized.id);
  }

  unregister(eventId: string): void {
    const event = this.#events.get(eventId);
    if (event === undefined) {
      return;
    }

    this.#events.delete(eventId);
    this.#subjects.delete(event.subject);
  }

  get(eventId: string): EventSchemaDefinition | undefined {
    return this.#events.get(eventId);
  }

  getBySubject(subject: string): EventSchemaDefinition | undefined {
    const eventId = this.#subjects.get(normalizeSubject(subject));
    return eventId === undefined ? undefined : this.#events.get(eventId);
  }

  list(): readonly EventSchemaDefinition[] {
    return [...this.#events.values()].sort((left, right) =>
      left.subject.localeCompare(right.subject),
    );
  }
}

export function createEventSchemaRegistry(
  events: readonly EventSchemaDefinition[] = [],
): EventSchemaRegistry {
  const registry = new InMemoryEventSchemaRegistry();
  for (const event of events) {
    registry.register(event);
  }
  return registry;
}

function normalizeEventSchemaDefinition(event: EventSchemaDefinition): EventSchemaDefinition {
  const id = normalizeId(event.id);
  const subject = normalizeSubject(event.subject);

  return {
    ...event,
    id,
    subject,
    direction: event.direction ?? "publish",
  };
}

function normalizeId(id: string): string {
  const normalized = id.trim();
  if (normalized.length === 0) {
    throw new Error("Event schema id must not be empty");
  }
  if (/\s/u.test(normalized)) {
    throw new Error(`Event schema id must not contain whitespace: ${id}`);
  }
  return normalized;
}

function normalizeSubject(subject: string): string {
  const normalized = subject.trim();
  if (normalized.length === 0) {
    throw new Error("Event subject must not be empty");
  }
  if (/\s/u.test(normalized)) {
    throw new Error(`Event subject must not contain whitespace: ${subject}`);
  }
  if (normalized.split(".").some((part) => part.length === 0)) {
    throw new Error(`Event subject must not contain empty tokens: ${subject}`);
  }
  return normalized;
}
