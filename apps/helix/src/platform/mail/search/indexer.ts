import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument, SearchEventIndexer, SearchIndexer, SearchIndexerEvent } from "../../search/index.js";
import type { MailActivityPayload, MailAddress, MailSearchProjectionStore, MailSearchRecord } from "../types.js";

export const mailSearchIndexerId = "mail";
export const mailSearchSubjects = ["activity.mail.>", "com.helix.core.mail.>"] as const;

export function createMailSearchIndexer(store: MailSearchProjectionStore): SearchIndexer<MailActivityPayload> {
  return {
    id: mailSearchIndexerId,
    subjects: mailSearchSubjects,
    async route(event) {
      const messageId = mailMessageIdFromEvent(event);
      if (messageId === undefined) {
        return undefined;
      }

      if (isDeleteSubject(event.subject)) {
        return { delete: [mailDocumentId(messageId)] };
      }

      const record = await store.getMailSearchRecord(messageId);
      if (record === null) {
        return { delete: [mailDocumentId(messageId)] };
      }

      return { upsert: [mailRecordToIndexDocument(record)] };
    },
  };
}

export function registerMailIndexer(indexer: SearchEventIndexer, store: MailSearchProjectionStore): void {
  indexer.register(createMailSearchIndexer(store));
}

export function mailRecordToIndexDocument(record: MailSearchRecord): IndexDocument {
  const labels = record.labels ?? [];
  const to = record.to.map(addressSearchText).join(", ");
  const cc = (record.cc ?? []).map(addressSearchText).join(", ");
  const bcc = (record.bcc ?? []).map(addressSearchText).join(", ");
  const body = [record.subject, addressSearchText(record.from), to, cc, bcc, labels.join(" "), record.body]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    id: mailDocumentId(record.id),
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
      // RAG visibility — mail is personal-by-default. Only the mailbox owner
      // can retrieve their mail via the assistant. Recipients indexing their
      // OWN copies is a follow-up (would need per-recipient indexing).
      ...(record.ownerActorId === null
        ? { ragVisibility: "org" }
        : { ragVisibility: "private", ragOwnerActorId: record.ownerActorId }),
    }),
    updatedAt: record.updatedAt ?? record.sentAt,
  };
}

export function mailDocumentId(messageId: string): string {
  return `mail:${messageId}`;
}

function mailMessageIdFromEvent(event: SearchIndexerEvent<MailActivityPayload>): string | undefined {
  const id = event.payload.messageId ?? event.payload.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isDeleteSubject(subject: string): boolean {
  return subject.endsWith(".deleted") || subject.endsWith(".delete");
}

function addressSearchText(address: MailAddress): string {
  const email = addressEmail(address);
  return address.name === undefined ? email : `${address.name} <${email}>`;
}

function addressEmail(address: MailAddress): string {
  return address.email ?? address.address;
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: Record<string, JsonObject[keyof JsonObject]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value as JsonObject[keyof JsonObject];
    }
  }
  return output;
}
