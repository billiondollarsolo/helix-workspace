import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument, SearchEventIndexer, SearchIndexer, SearchIndexerEvent } from "../../search/index.js";
import type { DocsActivityPayload, DocsActor, DocsSearchProjectionStore, DocsSearchRecord } from "../types.js";

export const docsSearchIndexerId = "docs";
export const docsSearchSubjects = ["activity.docs.>", "com.helix.core.docs.>"] as const;

export function createDocsSearchIndexer(store: DocsSearchProjectionStore): SearchIndexer<DocsActivityPayload> {
  return {
    id: docsSearchIndexerId,
    subjects: docsSearchSubjects,
    async route(event) {
      const docId = docsDocIdFromEvent(event);
      if (docId === undefined) {
        return undefined;
      }

      if (isDeleteSubject(event.subject)) {
        return { delete: [docsDocumentId(docId)] };
      }

      const record = await store.getDocsSearchRecord(docId);
      if (record === null || record.deletedAt !== undefined || record.archivedAt !== undefined) {
        return { delete: [docsDocumentId(docId)] };
      }

      return { upsert: [docsRecordToIndexDocument(record)] };
    },
  };
}

export function registerDocsIndexer(indexer: SearchEventIndexer, store: DocsSearchProjectionStore): void {
  indexer.register(createDocsSearchIndexer(store));
}

export function docsRecordToIndexDocument(record: DocsSearchRecord): IndexDocument {
  const outline = record.outline ?? [];
  const comments = record.comments ?? [];
  const tags = record.tags ?? [];
  const collaborators = record.collaborators ?? [];
  const body = [
    record.title,
    record.markdown,
    record.plainText,
    textFromHtml(record.html),
    outline.map((item) => `${"#".repeat(item.level)} ${item.title}${item.summary === undefined ? "" : ` ${item.summary}`}`).join("\n"),
    comments.map((comment) => comment.body).join("\n"),
    actorSearchText(record.owner),
    collaborators.map(actorSearchText).filter((part): part is string => part !== undefined).join("\n"),
    tags.join(" "),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");

  return {
    id: docsDocumentId(record.id),
    type: "docs",
    title: record.title,
    body,
    url: `/docs/${record.id}`,
    attributes: compactJsonObject({
      orgId: record.orgId,
      docId: record.id,
      ownerId: record.owner?.id,
      ownerName: record.owner?.displayName,
      ownerEmail: record.owner?.email,
      collaboratorIds: collaborators.map((actor) => actor.id),
      tags,
      outline: outline.map((item) => ({
        id: item.id,
        level: item.level,
        title: item.title,
        anchor: item.anchor,
      })),
      classification: record.classification,
      createdAt: timestampString(record.createdAt),
      metadata: record.metadata,
    }),
    updatedAt: timestampString(record.updatedAt ?? record.createdAt),
  };
}

export function docsDocumentId(docId: string): string {
  return `docs:${docId}`;
}

function docsDocIdFromEvent(event: SearchIndexerEvent<DocsActivityPayload>): string | undefined {
  const id = event.payload.docId ?? event.payload.documentId ?? event.payload.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isDeleteSubject(subject: string): boolean {
  return subject.endsWith(".deleted") || subject.endsWith(".delete") || subject.endsWith(".purged");
}

function actorSearchText(actor: DocsActor | undefined): string | undefined {
  if (actor === undefined) {
    return undefined;
  }
  if (actor.displayName !== undefined && actor.email !== undefined) {
    return `${actor.displayName} <${actor.email}>`;
  }
  return actor.displayName ?? actor.email ?? actor.id;
}

function textFromHtml(html: string | undefined): string | undefined {
  return html?.replace(/<br\s*\/?>/giu, "\n").replace(/<[^>]+>/gu, "").trim();
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

function timestampString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
