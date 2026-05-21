import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument, SearchEventIndexer, SearchIndexer, SearchIndexerEvent } from "../../search/index.js";
import type { DriveActivityPayload, DriveActor, DriveSearchProjectionStore, DriveSearchRecord } from "../types.js";

export const driveSearchIndexerId = "drive";
export const driveSearchSubjects = ["activity.drive.>", "com.helix.core.drive.>"] as const;

export function createDriveSearchIndexer(store: DriveSearchProjectionStore): SearchIndexer<DriveActivityPayload> {
  return {
    id: driveSearchIndexerId,
    subjects: driveSearchSubjects,
    async route(event) {
      const fileId = driveFileIdFromEvent(event);
      if (fileId === undefined) {
        return undefined;
      }

      if (isDeleteSubject(event.subject)) {
        return { delete: [driveDocumentId(fileId)] };
      }

      const record = await store.getDriveSearchRecord(fileId);
      if (record === null || record.deletedAt !== undefined || record.trashedAt !== undefined) {
        return { delete: [driveDocumentId(fileId)] };
      }

      return { upsert: [driveRecordToIndexDocument(record)] };
    },
  };
}

export function registerDriveIndexer(indexer: SearchEventIndexer, store: DriveSearchProjectionStore): void {
  indexer.register(createDriveSearchIndexer(store));
}

export function driveRecordToIndexDocument(record: DriveSearchRecord): IndexDocument {
  const tags = record.tags ?? [];
  const path = record.path ?? [];
  const body = [
    record.name,
    record.mimeType,
    path.join(" / "),
    actorSearchText(record.owner),
    tags.join(" "),
    record.summary,
    record.description,
    record.textContent,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");

  return {
    id: driveDocumentId(record.id),
    type: "drive",
    title: record.name,
    body,
    url: `/drive/${record.id}`,
    attributes: compactJsonObject({
      orgId: record.orgId,
      fileId: record.id,
      kind: record.kind,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      storageKey: record.storageKey,
      sha256: record.sha256,
      parentFolderId: record.parentFolderId,
      path,
      ownerId: record.owner?.id,
      ownerName: record.owner?.displayName,
      ownerEmail: record.owner?.email,
      tags,
      classification: record.classification,
      createdAt: record.createdAt,
      trashedAt: record.trashedAt,
      metadata: record.metadata,
    }),
    updatedAt: record.updatedAt ?? record.createdAt,
  };
}

export function driveDocumentId(fileId: string): string {
  return `drive:${fileId}`;
}

function driveFileIdFromEvent(event: SearchIndexerEvent<DriveActivityPayload>): string | undefined {
  const id = event.payload.fileId ?? event.payload.objectId ?? event.payload.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isDeleteSubject(subject: string): boolean {
  return subject.endsWith(".deleted") || subject.endsWith(".delete") || subject.endsWith(".purged");
}

function actorSearchText(actor: DriveActor | undefined): string | undefined {
  if (actor === undefined) {
    return undefined;
  }
  if (actor.displayName !== undefined && actor.email !== undefined) {
    return `${actor.displayName} <${actor.email}>`;
  }
  return actor.displayName ?? actor.email ?? actor.id;
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
