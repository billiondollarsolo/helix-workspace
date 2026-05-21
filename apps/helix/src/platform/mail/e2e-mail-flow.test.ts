import { describe, expect, it } from "vitest";
import type {
  AICallContext,
  AICapability,
  Actor,
  ChatRequest,
  ChatResponse,
  EventBus,
  EventEnvelope,
  JsonObject,
  JsonValue,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { EnrichmentWorker } from "../ai/enrichment/index.js";
import { SearchEventIndexer } from "../search/event-indexer.js";
import type {
  IndexDocument,
  SearchEngine,
  SearchRequest,
  SearchResponse,
} from "../search/types.js";
import { evaluateInboundMail } from "./filters.js";
import {
  createMailSuggestionSlotProviders,
  registerMailEnrichments,
  registerMailIndexer,
} from "./index.js";
import { MailSendService } from "./outbound.js";
import type {
  CreateMailFilterInput,
  CreateOutboundMailInput,
  MailStore,
  SetMailVacationInput,
  UpdateMailFilterInput,
} from "./store.js";
import type {
  MailAddress,
  MailClassificationWrite,
  MailEnrichmentProjectionStore,
  MailEnrichmentRecord,
  MailEnrichmentWrite,
  MailFilterRecord,
  MailMessageInput,
  MailOutboundRecord,
  MailOutboundStatus,
  MailSearchHit,
  MailSearchProjectionStore,
  MailSearchRecord,
  MailSearchRequest,
  MailThreadDetail,
  MailThreadGetRequest,
  MailThreadStatePatch,
  MailVacationRecord,
  StoredMailMessage,
} from "./types.js";

const now = new Date("2026-05-20T12:00:00.000Z");

describe("mail AI/search flow", () => {
  it("covers send receive reply label search filter and AI compose help against a store-backed mail flow", async () => {
    const actor: Actor = {
      id: "actor-1",
      orgId: "org-1",
      type: "user",
      displayName: "Ada",
      email: "ada@example.com",
    };
    const events = new FakeEventBus();
    const engine = new FakeSearchEngine();
    const mail = new InMemoryMailPlatformStore(events);
    const ai = new FakeAI();
    const enrichmentResults: string[] = [];

    mail.seedActorAddress(actor.orgId, "ada@example.com", actor.id);
    await mail.createFilter({
      orgId: actor.orgId,
      actorId: actor.id,
      name: "Manager mail",
      criteria: { fromContains: "manager@example.com" },
      actions: { applyLabels: ["work"] },
    });

    const indexer = new SearchEventIndexer({ events, engine });
    registerMailIndexer(indexer, mail);
    const enrichmentWorker = new EnrichmentWorker({
      events,
      subject: "activity.>",
      onResult: (result) => {
        enrichmentResults.push(`${result.feature}:${result.status}`);
      },
    });
    registerMailEnrichments(enrichmentWorker, {
      store: mail,
      ai,
      entityExtract: true,
      classification: true,
    });

    await indexer.start();
    await enrichmentWorker.start();

    const sent = await mail.send({
      actor,
      to: [mailAddress("manager@example.com", "Manager")],
      subject: "Roadmap check-in",
      body: "Can we review the roadmap tomorrow?",
    });
    const received = await mail.receive({
      from: mailAddress("manager@example.com", "Manager"),
      to: [mailAddress("ada@example.com", "Ada")],
      subject: "Re: Roadmap check-in",
      body: "The restricted roadmap moved. Please reply with action items.",
      threadId: sent.threadId,
    });
    const reply = await mail.reply({
      actor,
      threadId: received.threadId,
      to: [received.from],
      subject: "Re: Roadmap check-in",
      body: "I will send the action items after the review.",
    });
    await mail.applyLabel(actor, received.threadId, "important");

    const search = await engine.search({
      query: "roadmap action",
      types: ["mail"],
      filter: 'attributes.labels = "work"',
    });
    const providers = createMailSuggestionSlotProviders({ ai });
    const composeHelp = providers.find((provider) => provider.slotId === "mail.compose-help");
    if (composeHelp === undefined) {
      throw new Error("compose-help provider missing");
    }
    const chunks = [];
    for await (const chunk of composeHelp.generate({
      actor,
      feature: "mail.compose-help",
      input: {
        subject: "Re: Roadmap check-in",
        body: "Need to acknowledge the moved review and promise action items.",
        recipients: ["manager@example.com"],
      },
    })) {
      chunks.push(chunk.text);
    }

    await enrichmentWorker.stop();
    await indexer.stop();

    await expect(mail.getMailSearchRecord(received.id)).resolves.toMatchObject({
      labels: ["important", "work"],
    });
    expect(reply.threadId).toBe(received.threadId);
    expect(search.hits.map((hit) => hit.id)).toContain(`mail:${received.id}`);
    expect(search.hits.every((hit) => hit.type === "mail")).toBe(true);
    expect(chunks.join("")).toContain("Draft:");
    expect(ai.calls.map((call) => call.feature)).toContain("mail.compose-help");
    expect(enrichmentResults).toContain("mail.entity-extract:applied");
    expect(mail.classifications.get(received.id)?.classification).toBe("restricted");
  });
});

interface MailSendInput {
  readonly actor: Actor;
  readonly to: readonly MailAddress[];
  readonly subject: string;
  readonly body: string;
}

interface MailReceiveInput {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly threadId?: string | undefined;
}

interface MailReplyInput extends MailSendInput {
  readonly threadId: string;
}

class InMemoryMailPlatformStore
  implements MailStore, MailSearchProjectionStore, MailEnrichmentProjectionStore
{
  readonly classifications = new Map<string, MailClassificationWrite>();
  readonly enrichments: MailEnrichmentWrite[] = [];
  readonly outbounds: MailOutboundRecord[] = [];
  vacation: MailVacationRecord | null = null;

  readonly #actorByAddress = new Map<string, string>();
  readonly #messages = new Map<string, MailSearchRecord>();
  readonly #filters: MailFilterRecord[] = [];
  readonly #states = new Map<
    string,
    {
      labels: string[];
      archivedAt?: Date;
      deletedAt?: Date;
      snoozedUntil?: Date;
      readAt?: Date | null;
      starred?: boolean;
    }
  >();
  readonly #vacationResponses = new Set<string>();
  #nextFilter = 1;
  #nextMessage = 1;
  #nextOutbound = 1;
  #nextThread = 1;

  constructor(private readonly events: EventBus) {}

  seedActorAddress(orgId: string, address: string, actorId: string): void {
    this.#actorByAddress.set(`${orgId}:${address.toLowerCase()}`, actorId);
  }

  async send(input: MailSendInput): Promise<MailSearchRecord> {
    const outbound = await new MailSendService({ store: this, undoWindowMs: 0 }).queue({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      now,
      envelope: {
        from: mailAddress(input.actor.email ?? "user@example.com", input.actor.displayName),
        to: input.to,
        cc: [],
        bcc: [],
        subject: input.subject,
        text: input.body,
        attachments: [],
      },
    });
    return this.requireRecord(outbound.messageId);
  }

  async receive(input: MailReceiveInput): Promise<MailSearchRecord> {
    const recipient = input.to[0];
    const resolvedActor =
      recipient === undefined
        ? null
        : await this.findActorByAddress("org-1", addressEmail(recipient));
    const message: MailMessageInput = {
      orgId: "org-1",
      ...(resolvedActor?.actorId === undefined ? {} : { actorId: resolvedActor.actorId }),
      from: input.from,
      to: input.to,
      subject: input.subject,
      bodyText: input.body,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      receivedAt: now,
    };
    const stored = await this.insertInboundMessage(message);
    await evaluateInboundMail(this, {
      message,
      stored,
      recipientActorId: resolvedActor?.actorId ?? null,
      now,
    });
    return this.requireRecord(stored.messageId);
  }

  async reply(input: MailReplyInput): Promise<MailSearchRecord> {
    const outbound = await new MailSendService({ store: this, undoWindowMs: 0 }).queue({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      threadId: input.threadId,
      now,
      envelope: {
        from: mailAddress(input.actor.email ?? "user@example.com", input.actor.displayName),
        to: input.to,
        cc: [],
        bcc: [],
        subject: input.subject,
        text: input.body,
        attachments: [],
      },
    });
    return this.requireRecord(outbound.messageId);
  }

  async applyLabel(actor: Actor, threadId: string, label: string): Promise<void> {
    await this.updateThreadState({
      orgId: actor.orgId,
      actorId: actor.id,
      threadId,
      patch: { addLabels: [label] },
    });
  }

  async findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null> {
    const email = address.toLowerCase();
    const actorId = this.#actorByAddress.get(`${orgId}:${email}`);
    return actorId === undefined ? null : { actorId, email };
  }

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    const stored = await this.insertMessage(input);
    await this.events.publish("activity.mail.received", {
      orgId: input.orgId,
      actorId: input.actorId ?? null,
      threadId: stored.threadId,
      messageId: stored.messageId,
    });
    return stored;
  }

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    const stored = await this.insertMessage({
      orgId: input.orgId,
      actorId: input.actorId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      from: input.envelope.from,
      to: input.envelope.to,
      cc: input.envelope.cc,
      bcc: input.envelope.bcc,
      subject: input.envelope.subject,
      bodyText: input.envelope.text,
      ...(input.envelope.html === undefined ? {} : { bodyHtml: input.envelope.html }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.references === undefined ? {} : { references: input.references }),
      attachments: input.envelope.attachments,
      receivedAt: now,
      metadata: { direction: "outbound" },
    });
    const timestamp = new Date(now);
    const outbound: MailOutboundRecord = {
      id: `outbound-${String(this.#nextOutbound)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      messageId: stored.messageId,
      threadId: stored.threadId,
      outboxId: `outbox-${String(this.#nextOutbound)}`,
      status: "queued",
      envelope: input.envelope,
      undoUntil: input.undoUntil,
      sentAt: null,
      cancelledAt: null,
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      deliveryMetadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#nextOutbound += 1;
    this.outbounds.push(outbound);
    await this.events.publish("activity.mail.created", {
      orgId: input.orgId,
      actorId: input.actorId,
      threadId: stored.threadId,
      messageId: stored.messageId,
    });
    return outbound;
  }

  async getOutbound(id: string): Promise<MailOutboundRecord | null> {
    return this.outbounds.find((outbound) => outbound.id === id) ?? null;
  }

  async markOutboundSending(id: string): Promise<MailOutboundRecord | null> {
    return this.updateOutbound(id, (outbound) =>
      outbound.status === "queued" && outbound.undoUntil <= now
        ? { ...outbound, status: "sending" }
        : null,
    );
  }

  async markOutboundSent(input: {
    readonly id: string;
    readonly sentAt?: Date;
    readonly providerMessageId?: string;
    readonly deliveryMetadata?: JsonObject;
  }): Promise<MailOutboundRecord | null> {
    return this.updateOutbound(input.id, (outbound) => ({
      ...outbound,
      status: "sent",
      sentAt: input.sentAt ?? now,
      lastError: null,
      providerMessageId: input.providerMessageId ?? null,
      deliveryMetadata: input.deliveryMetadata ?? {},
    }));
  }

  async markOutboundFailed(
    id: string,
    error: string,
    failedAt: Date = now,
  ): Promise<MailOutboundRecord | null> {
    return this.updateOutbound(id, (outbound) => ({
      ...outbound,
      status: "failed",
      failedAt,
      lastError: error,
    }));
  }

  async cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    return this.updateOutbound(input.id, (outbound) =>
      outbound.orgId === input.orgId &&
      outbound.actorId === input.actorId &&
      outbound.status === "queued" &&
      outbound.undoUntil > now
        ? { ...outbound, status: "cancelled", cancelledAt: now }
        : null,
    );
  }

  async updateThreadState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void> {
    const key = threadStateKey(input.actorId, input.threadId);
    const current = this.#states.get(key) ?? { labels: [] };
    const labels = mergeLabels(
      current.labels,
      input.patch.addLabels ?? [],
      input.patch.removeLabels ?? [],
    );
    const archivedAt = input.patch.archivedAt ?? current.archivedAt;
    const deletedAt = input.patch.deletedAt ?? current.deletedAt;
    const snoozedUntil = input.patch.snoozedUntil ?? current.snoozedUntil;
    const readAt = input.patch.readAt === undefined ? current.readAt : input.patch.readAt;
    const starred = input.patch.starred ?? current.starred;
    const state = {
      labels,
      ...(archivedAt === undefined ? {} : { archivedAt }),
      ...(deletedAt === undefined ? {} : { deletedAt }),
      ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
      ...(readAt === undefined ? {} : { readAt }),
      ...(starred === undefined ? {} : { starred }),
    };
    this.#states.set(key, state);

    for (const record of this.#messages.values()) {
      if (record.orgId !== input.orgId || record.threadId !== input.threadId) {
        continue;
      }
      this.#messages.set(record.id, {
        ...record,
        labels,
        updatedAt: now.toISOString(),
      });
      await this.events.publish("activity.mail.updated", {
        orgId: input.orgId,
        actorId: input.actorId,
        threadId: input.threadId,
        messageId: record.id,
      });
    }
  }

  async createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord> {
    const timestamp = new Date(now);
    const filter: MailFilterRecord = {
      id: `filter-${String(this.#nextFilter)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      name: input.name,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      criteria: input.criteria,
      actions: input.actions,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#nextFilter += 1;
    this.#filters.push(filter);
    return filter;
  }

  async updateFilter(input: UpdateMailFilterInput): Promise<MailFilterRecord | null> {
    const index = this.#filters.findIndex(
      (filter) =>
        filter.orgId === input.orgId && filter.actorId === input.actorId && filter.id === input.id,
    );
    if (index < 0) {
      return null;
    }
    const current = this.#filters[index];
    if (current === undefined) {
      return null;
    }
    const updated: MailFilterRecord = {
      ...current,
      ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
      ...(input.patch.enabled === undefined ? {} : { enabled: input.patch.enabled }),
      ...(input.patch.priority === undefined ? {} : { priority: input.patch.priority }),
      ...(input.patch.criteria === undefined ? {} : { criteria: input.patch.criteria }),
      ...(input.patch.actions === undefined ? {} : { actions: input.patch.actions }),
      updatedAt: now,
    };
    this.#filters[index] = updated;
    return updated;
  }

  async deleteFilter(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<boolean> {
    const index = this.#filters.findIndex(
      (filter) =>
        filter.orgId === input.orgId && filter.actorId === input.actorId && filter.id === input.id,
    );
    if (index < 0) {
      return false;
    }
    this.#filters.splice(index, 1);
    return true;
  }

  async listFilters(orgId: string, actorId: string): Promise<readonly MailFilterRecord[]> {
    return this.#filters
      .filter((filter) => filter.orgId === orgId && filter.actorId === actorId)
      .sort(
        (left, right) =>
          left.priority - right.priority || left.createdAt.getTime() - right.createdAt.getTime(),
      );
  }

  async getVacation(orgId: string, actorId: string): Promise<MailVacationRecord | null> {
    return this.vacation?.orgId === orgId && this.vacation.actorId === actorId
      ? this.vacation
      : null;
  }

  async setVacation(input: SetMailVacationInput): Promise<MailVacationRecord> {
    const vacation: MailVacationRecord = {
      id: this.vacation?.id ?? "vacation-1",
      orgId: input.orgId,
      actorId: input.actorId,
      enabled: input.enabled,
      subject: input.subject,
      body: input.body,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      metadata: input.metadata,
      createdAt: this.vacation?.createdAt ?? now,
      updatedAt: now,
    };
    this.vacation = vacation;
    return vacation;
  }

  async getActiveVacation(
    orgId: string,
    actorId: string,
    at: Date = now,
  ): Promise<MailVacationRecord | null> {
    if (
      this.vacation === null ||
      this.vacation.orgId !== orgId ||
      this.vacation.actorId !== actorId ||
      !this.vacation.enabled ||
      (this.vacation.startsAt !== null && this.vacation.startsAt > at) ||
      (this.vacation.endsAt !== null && this.vacation.endsAt < at)
    ) {
      return null;
    }
    return this.vacation;
  }

  async hasVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }): Promise<boolean> {
    return this.#vacationResponses.has(`${input.vacationId}:${input.senderEmail.toLowerCase()}`);
  }

  async recordVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }): Promise<boolean> {
    const key = `${input.vacationId}:${input.senderEmail.toLowerCase()}`;
    if (this.#vacationResponses.has(key)) {
      return false;
    }
    this.#vacationResponses.add(key);
    return true;
  }

  async search(input: MailSearchRequest): Promise<readonly MailSearchHit[]> {
    const requestedLabels = new Set(input.labels ?? []);
    const query = input.query?.toLowerCase() ?? "";
    return [...this.#messages.values()]
      .filter((record) => record.orgId === input.orgId)
      .filter(
        (record) =>
          query.length === 0 || `${record.subject}\n${record.body}`.toLowerCase().includes(query),
      )
      .filter(
        (record) =>
          requestedLabels.size === 0 ||
          (record.labels ?? []).some((label) => requestedLabels.has(label)),
      )
      .slice(0, input.limit ?? 50)
      .map((record) => ({
        threadId: record.threadId,
        messageId: record.id,
        subject: record.subject,
        from: record.from,
        preview: record.body.slice(0, 240),
        sentAt: new Date(record.sentAt),
        labels: record.labels ?? [],
        unread: this.isUnread(input.actorId, record.threadId, new Date(record.sentAt)),
        starred: this.#states.get(threadStateKey(input.actorId, record.threadId))?.starred ?? false,
      }));
  }

  async getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null> {
    const messages = [...this.#messages.values()]
      .filter((record) => record.orgId === input.orgId && record.threadId === input.threadId)
      .sort((left, right) => left.sentAt.localeCompare(right.sentAt));
    if (messages.length === 0) {
      return null;
    }
    const state = this.#states.get(threadStateKey(input.actorId, input.threadId));
    const last = messages.at(-1);
    if (last === undefined) {
      return null;
    }
    const directions = new Set(messages.map((message) => message.direction));
    const onlyDirection = directions.values().next().value;
    return {
      id: input.threadId,
      subject: last.subject,
      preview: last.body.slice(0, 240),
      participants: uniqueMailAddresses(
        messages.flatMap((message) => [message.from, ...message.to]),
      ),
      messages: messages.map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        bcc: message.bcc ?? [],
        sentAt: new Date(message.sentAt),
        body: message.body,
        bodyFormat: "plain",
        hasAttachment: false,
        attachments: [],
      })),
      labels: state?.labels ?? [],
      archivedAt: state?.archivedAt ?? null,
      deletedAt: state?.deletedAt ?? null,
      snoozedUntil: state?.snoozedUntil ?? null,
      lastActivity: new Date(last.sentAt),
      unread:
        state?.readAt === undefined ||
        state.readAt === null ||
        state.readAt < new Date(last.sentAt),
      starred: state?.starred ?? false,
      direction: directions.size === 1 && onlyDirection !== undefined ? onlyDirection : "mixed",
    };
  }

  private isUnread(actorId: string, threadId: string, sentAt: Date): boolean {
    const readAt = this.#states.get(threadStateKey(actorId, threadId))?.readAt;
    return readAt === undefined || readAt === null || readAt < sentAt;
  }

  async getMailSearchRecord(messageId: string): Promise<MailSearchRecord | null> {
    return this.#messages.get(messageId) ?? null;
  }

  async getMailEnrichmentRecord(messageId: string): Promise<MailEnrichmentRecord | null> {
    return this.#messages.get(messageId) ?? null;
  }

  async recordMailEnrichment(input: MailEnrichmentWrite): Promise<void> {
    this.enrichments.push(input);
  }

  async setMailClassification(input: MailClassificationWrite): Promise<void> {
    this.classifications.set(input.messageId, input);
    const existing = this.#messages.get(input.messageId);
    if (existing !== undefined) {
      this.#messages.set(input.messageId, { ...existing, classification: input.classification });
    }
  }

  private async insertMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    const threadId = input.threadId ?? `thread-${String(this.#nextThread)}`;
    if (input.threadId === undefined) {
      this.#nextThread += 1;
    }
    const id = `message-${String(this.#nextMessage)}`;
    this.#nextMessage += 1;
    const direction = input.metadata?.direction === "outbound" ? "outbound" : "inbound";
    const labels =
      input.actorId === undefined || input.actorId === null
        ? []
        : (this.#states.get(threadStateKey(input.actorId, threadId))?.labels ?? []);
    const message: MailSearchRecord = {
      id,
      orgId: input.orgId,
      threadId,
      subject: input.subject,
      body: input.bodyText,
      from: input.from,
      to: input.to,
      ...(input.cc === undefined ? {} : { cc: input.cc }),
      ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
      labels,
      direction,
      sentAt: (input.receivedAt ?? now).toISOString(),
      metadata: input.metadata ?? {},
    };
    this.#messages.set(id, message);
    return { threadId, messageId: id, attachmentObjectIds: [] };
  }

  private requireRecord(messageId: string): MailSearchRecord {
    const record = this.#messages.get(messageId);
    if (record === undefined) {
      throw new Error(`unknown message ${messageId}`);
    }
    return record;
  }

  private updateOutbound(
    id: string,
    updater: (
      outbound: MailOutboundRecord,
    ) => (MailOutboundRecord & { readonly status: MailOutboundStatus }) | null,
  ): MailOutboundRecord | null {
    const index = this.outbounds.findIndex((outbound) => outbound.id === id);
    if (index < 0) {
      return null;
    }
    const current = this.outbounds[index];
    if (current === undefined) {
      return null;
    }
    const updated = updater(current);
    if (updated === null) {
      return null;
    }
    this.outbounds[index] = { ...updated, updatedAt: now };
    return this.outbounds[index] ?? null;
  }
}

function mailAddress(email: string, name?: string): MailAddress {
  return {
    address: email,
    email,
    ...(name === undefined ? {} : { name }),
  };
}

function uniqueMailAddresses(addresses: readonly MailAddress[]): readonly MailAddress[] {
  const byAddress = new Map<string, MailAddress>();
  for (const address of addresses) {
    byAddress.set(address.address.toLowerCase(), address);
  }
  return [...byAddress.values()];
}

function addressEmail(address: MailAddress): string {
  return address.email ?? address.address;
}

function threadStateKey(actorId: string, threadId: string): string {
  return `${actorId}:${threadId}`;
}

function mergeLabels(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const labels = new Set(current);
  for (const label of add) {
    labels.add(label);
  }
  for (const label of remove) {
    labels.delete(label);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly docs = new Map<string, IndexDocument>();

  async index(document: IndexDocument): Promise<void> {
    this.docs.set(document.id, document);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    for (const document of documents) {
      this.docs.set(document.id, document);
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hits = [...this.docs.values()].filter((document) => {
      const haystack = `${document.title ?? ""}\n${document.body ?? ""}`.toLowerCase();
      const matchesQuery = terms.every((term) => haystack.includes(term));
      const matchesType = request.types === undefined || request.types.includes(document.type);
      const matchesFilter = matchesLabelFilter(document, request.filter);
      return matchesQuery && matchesType && matchesFilter;
    });
    return { hits, query: request.query, estimatedTotalHits: hits.length };
  }
}

class FakeAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (request.feature === "mail.entity-extract") {
      return {
        message: JSON.stringify({
          people: ["manager@example.com"],
          actionItems: ["reply with action items"],
        }),
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    return {
      message: `Draft: Thanks for the update. I will follow up with action items after the review.`,
      model: "fake-model",
      providerId: "fake-ai",
    };
  }
}

class FakeEventBus implements EventBus {
  readonly subscriptions: string[] = [];
  readonly #subscribers: {
    readonly subject: string;
    readonly handler: (event: EventEnvelope) => Promise<void>;
  }[] = [];

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const event: EventEnvelope = {
      subject,
      payload,
      occurredAt: "2026-05-20T00:00:00.000Z",
      ...(trace === undefined ? {} : { trace }),
    };
    for (const subscriber of this.#subscribers) {
      if (subjectMatches(subscriber.subject, subject)) {
        await subscriber.handler(event);
      }
    }
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.subscriptions.push(subject);
    const subscriber = {
      subject,
      handler: handler as (event: EventEnvelope) => Promise<void>,
    };
    this.#subscribers.push(subscriber);
    return () => {
      const index = this.#subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.#subscribers.splice(index, 1);
      }
    };
  }
}

function matchesLabelFilter(document: IndexDocument, filter: SearchRequest["filter"]): boolean {
  const filters = typeof filter === "string" ? [filter] : (filter ?? []);
  const labels = document.attributes?.labels;
  if (!Array.isArray(labels)) {
    return !filters.some((candidate) => candidate.includes("attributes.labels"));
  }
  return filters.every((candidate) => {
    const match = /attributes\.labels\s*=\s*"([^"]+)"/u.exec(candidate);
    return match === null ? true : labels.includes(match[1]);
  });
}

function subjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}
