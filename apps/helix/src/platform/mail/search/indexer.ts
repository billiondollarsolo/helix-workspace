import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument, SearchIndexer, SearchIndexerEvent } from "../../search/types.js";
import type { SearchEventIndexer } from "../../search/event-indexer.js";
import type {
  MailActivityPayload,
  MailAddress,
  MailSearchProjectionStore,
  MailSearchRecord,
} from "../types.js";

export const mailSearchIndexerId = "mail";
export const mailSearchSubjects = ["activity.mail.>", "com.helix.core.mail.>"] as const;

export function createMailSearchIndexer(
  store: MailSearchProjectionStore,
): SearchIndexer<MailActivityPayload> {
  return {
    id: mailSearchIndexerId,
    subjects: mailSearchSubjects,
    async route(event) {
      const messageId = mailMessageIdFromEvent(event);
      const scope = mailScopeFromEvent(event);
      if (messageId === undefined || scope === undefined) {
        return undefined;
      }

      if (isDeleteSubject(event.subject)) {
        return { delete: [mailDocumentId(messageId, scope.actorId)] };
      }

      const record = await store.getMailSearchRecord({ ...scope, messageId });
      if (record === null) {
        return { delete: [mailDocumentId(messageId, scope.actorId)] };
      }

      return { upsert: [mailRecordToIndexDocument(record)] };
    },
  };
}

function mailScopeFromEvent(
  event: SearchIndexerEvent<MailActivityPayload>,
): { readonly orgId: string; readonly actorId: string } | undefined {
  const { orgId, actorId } = event.payload;
  return typeof orgId === "string" &&
    orgId.length > 0 &&
    typeof actorId === "string" &&
    actorId.length > 0
    ? { orgId, actorId }
    : undefined;
}

export function registerMailIndexer(
  indexer: SearchEventIndexer,
  store: MailSearchProjectionStore,
): void {
  indexer.register(createMailSearchIndexer(store));
}

export function mailRecordToIndexDocument(record: MailSearchRecord): IndexDocument {
  const labels = record.labels ?? [];
  const to = joinAddresses(record.to);
  const cc = joinAddresses(record.cc);
  const bcc = joinAddresses(record.bcc);
  const body = [
    record.subject,
    addressSearchText(record.from),
    to,
    cc,
    bcc,
    labels.join(" "),
    record.body,
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    id: mailDocumentId(record.id, record.ownerActorId),
    type: "mail",
    title: record.subject,
    body,
    url: `/mail/${record.threadId}?message=${record.id}`,
    attributes: compactJsonObject({
      orgId: record.orgId,
      threadId: record.threadId,
      messageId: record.id,
      from: addressEmail(record.from),
      fromName: record.from.name,
      to: record.to.map(addressEmail),
      cc: (record.cc ?? []).map(addressEmail),
      labels,
      folder: record.folder,
      direction: record.direction,
      classification: record.classification,
      sentAt: record.sentAt,
      metadata: record.metadata,
      ragVisibility: "private",
      ragOwnerActorId: record.ownerActorId,
    }),
    updatedAt: record.updatedAt ?? record.sentAt,
  };
}

export function mailDocumentId(messageId: string, actorId: string): string {
  return `mail:${actorId}:${messageId}`;
}

function mailMessageIdFromEvent(
  event: SearchIndexerEvent<MailActivityPayload>,
): string | undefined {
  const id = event.payload.messageId ?? event.payload.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isDeleteSubject(subject: string): boolean {
  return subject.endsWith(".deleted") || subject.endsWith(".delete");
}

function joinAddresses(addresses: readonly MailAddress[] | undefined): string {
  return (addresses ?? []).map(addressSearchText).join(", ");
}

function addressSearchText(address: MailAddress): string {
  const email = addressEmail(address);
  return address.name === undefined ? email : `${address.name} <${email}>`;
}

function addressEmail(address: MailAddress): string {
  return address.email ?? address.address;
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  ) as JsonObject;
}
