import type {
  IndexDocument,
  SearchEventIndexer,
  SearchIndexer,
  SearchIndexerEvent,
} from "../../search/index.js";
import { compactJsonObject } from "../../util/json.js";
import type {
  DriveActivityPayload,
  DriveActor,
  DriveSearchProjectionStore,
  DriveSearchRecord,
} from "../types.js";

const driveSearchIndexerId = "drive";
const driveSearchSubjects = ["activity.drive.>", "com.helix.core.drive.>"] as const;

export function createDriveSearchIndexer(
  store: DriveSearchProjectionStore,
): SearchIndexer<DriveActivityPayload> {
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

export function registerDriveIndexer(
  indexer: SearchEventIndexer,
  store: DriveSearchProjectionStore,
): void {
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
      parentFolderId: record.parentFolderId,
      path,
      ownerId: record.owner?.id,
      ownerName: record.owner?.displayName,
      allowedActorIds: record.allowedActorIds ?? [],
      tags,
      classification: record.classification,
      createdAt: record.createdAt,
      // Tenant isolation happens in the vector store; object ACLs are applied
      // from allowedActorIds by the semantic search layer.
      ragVisibility: "org",
    }),
    updatedAt: record.updatedAt ?? record.createdAt,
  };
}

function driveDocumentId(fileId: string): string {
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
