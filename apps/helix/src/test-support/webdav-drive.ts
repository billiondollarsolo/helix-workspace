import type { Actor } from "@helix/sdk-types";
import { createHash, randomUUID } from "node:crypto";
import type { AppPasswordAuthenticator } from "../platform/auth/app-passwords.js";
import type { WebDavDriveStore } from "../platform/drive/routes.js";
import type {
  DriveFileReadInput,
  DriveFileReadResult,
  DriveFolderCreateInput,
  FinalizeDriveUploadInput,
  PrepareDriveUploadInput,
} from "../platform/drive/store.js";
import type {
  DriveEntryRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
  DriveWebDavChange,
  DriveWebDavLock,
} from "../platform/drive/types.js";
const now = new Date("2026-05-20T12:00:00.000Z");
export const orgId = "11111111-1111-4111-8111-111111111111";
export const actorId = "22222222-2222-4222-8222-222222222222";
export const folderId = "33333333-3333-4333-8333-333333333333";
export const emptyFolderId = "33333333-3333-4333-8333-333333333334";
export const nestedFolderId = "33333333-3333-4333-8333-333333333335";
export const reportId = "44444444-4444-4444-8444-444444444444";
export const uploadId = "55555555-5555-4555-8555-555555555555";

export class FakeAppPasswordAuthenticator implements AppPasswordAuthenticator {
  async authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
    readonly compatibilityScope?: string;
  }): Promise<Actor | null> {
    if (input.username !== "ada@example.test") {
      return null;
    }
    const scopesByPassword: Record<string, readonly string[]> = {
      read: ["drive.read"],
      write: ["drive.read", "drive.write"],
      delete: ["drive.read", "drive.write", "drive.delete"],
      webdav: ["webdav"],
    };
    const scopes = scopesByPassword[input.password] ?? [];
    if (
      !scopes.includes(input.requiredScope) &&
      (input.compatibilityScope === undefined || !scopes.includes(input.compatibilityScope))
    ) {
      return null;
    }
    return {
      id: actorId,
      orgId,
      type: "user",
      email: input.username,
      displayName: "Ada Lovelace",
      scopes: [...scopes],
    };
  }
}

export class FakeWebDavDriveStore implements WebDavDriveStore {
  readonly uploads: PrepareDriveUploadInput[] = [];
  readonly finalized: FinalizeDriveUploadInput[] = [];
  readonly deleted: string[] = [];
  readonly trashed: string[] = [];
  readonly trashedFolders: string[] = [];
  readonly locks = new Map<string, DriveWebDavLock>();
  readonly changes: DriveWebDavChange[] = [];
  syncMinimum = "0";
  failFinalize = false;
  readonly folders: DriveEntryRecord[] = [
    folderEntry("Projects", folderId, null),
    folderEntry("Empty", emptyFolderId, null),
    folderEntry("Archive", nestedFolderId, folderId),
  ];
  readonly files = new Map<string, DriveEntryRecord>([
    ["report.txt", fileEntry({ id: reportId, name: "report.txt", content: "quarterly report" })],
    [
      "roadmap.md",
      fileEntry({
        id: "88888888-8888-4888-8888-888888888888",
        name: "roadmap.md",
        content: "roadmap",
        folderId,
      }),
    ],
    [
      "archive.txt",
      fileEntry({
        id: "99999999-9999-4999-8999-999999999999",
        name: "archive.txt",
        content: "archive",
        folderId: nestedFolderId,
      }),
    ],
  ]);
  readonly content = new Map<string, Uint8Array>([
    [reportId, Buffer.from("quarterly report")],
    ["88888888-8888-4888-8888-888888888888", Buffer.from("roadmap")],
    ["99999999-9999-4999-8999-999999999999", Buffer.from("archive")],
  ]);

  async acquireWebDavLock(
    input: Parameters<WebDavDriveStore["acquireWebDavLock"]>[0],
  ): Promise<DriveWebDavLock | null> {
    for (const [path, lock] of this.locks) {
      if (lock.expiresAt <= new Date()) this.locks.delete(path);
    }
    const direct = this.locks.get(input.pathKey);
    if (input.token !== undefined) {
      if (
        direct === undefined ||
        direct.actorId !== input.actorId ||
        direct.token !== input.token
      ) {
        return null;
      }
      const refreshed = {
        ...direct,
        expiresAt: new Date(Date.now() + input.timeoutSeconds * 1_000),
      };
      this.locks.set(input.pathKey, refreshed);
      return refreshed;
    }
    const conflict = [...this.locks.values()].some(
      (lock) =>
        lock.pathKey === input.pathKey ||
        (lock.depth === "infinity" &&
          (lock.pathKey === "/" || input.pathKey.startsWith(`${lock.pathKey}/`))) ||
        (input.depth === "infinity" &&
          (input.pathKey === "/" || lock.pathKey.startsWith(`${input.pathKey}/`))),
    );
    if (conflict) return null;
    const createdAt = new Date();
    const lock: DriveWebDavLock = {
      pathKey: input.pathKey,
      token: `opaquelocktoken:${randomUUID()}`,
      actorId: input.actorId,
      owner: input.owner,
      depth: input.depth,
      fence: String(this.locks.size + 1),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + input.timeoutSeconds * 1_000),
    };
    this.locks.set(input.pathKey, lock);
    return lock;
  }

  async listWebDavLocks(
    input: Parameters<WebDavDriveStore["listWebDavLocks"]>[0],
  ): Promise<readonly DriveWebDavLock[]> {
    return [...this.locks.values()].filter(
      (lock) =>
        lock.expiresAt > new Date() &&
        input.pathKeys.some(
          (path) =>
            lock.pathKey === path ||
            (lock.depth === "infinity" &&
              (lock.pathKey === "/" || path.startsWith(`${lock.pathKey}/`))),
        ),
    );
  }

  async releaseWebDavLock(
    input: Parameters<WebDavDriveStore["releaseWebDavLock"]>[0],
  ): Promise<boolean> {
    const lock = this.locks.get(input.pathKey);
    if (lock?.actorId !== input.actorId || lock.token !== input.token) return false;
    return this.locks.delete(input.pathKey);
  }

  async listWebDavChanges(
    input: Parameters<WebDavDriveStore["listWebDavChanges"]>[0],
  ): ReturnType<WebDavDriveStore["listWebDavChanges"]> {
    const current = this.changes.at(-1)?.version ?? "0";
    if (input.afterVersion === undefined) {
      return { changes: [], version: current, valid: true, hasMore: false };
    }
    if (
      BigInt(input.afterVersion) < BigInt(this.syncMinimum) ||
      BigInt(input.afterVersion) > BigInt(current)
    ) {
      return { changes: [], version: current, valid: false, hasMore: false };
    }
    const changes = this.changes.filter(
      (change) => BigInt(change.version) > BigInt(input.afterVersion ?? "0"),
    );
    const page = changes.slice(0, input.limit);
    const hasMore = changes.length > page.length;
    return {
      changes: page,
      version: hasMore ? (page.at(-1)?.version ?? input.afterVersion) : current,
      valid: true,
      hasMore,
    };
  }

  async prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord> {
    this.uploads.push(input);
    const entry = fileEntry({
      id: uploadId,
      name: input.name,
      content: "",
      folderId: input.folderId ?? null,
      byteSize: input.byteSize,
      sha256: input.sha256 ?? null,
    });
    this.files.set(fileKey(input.folderId ?? null, input.name), entry);
    return {
      objectId: uploadId,
      orgId: input.orgId,
      ownerActorId: input.actorId,
      name: input.name,
      folderId: input.folderId ?? null,
      storageKey: `drive/${input.orgId}/${uploadId}/v1/${input.name}`,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256 ?? null,
      status: "pending_upload",
      uploadUrl: null,
      uploadHeaders: {},
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord> {
    this.finalized.push(input);
    if (this.failFinalize) throw new Error("interrupted upload");
    const existing = [...this.files.values()].find((file) => file.id === input.objectId);
    if (existing !== undefined && input.content !== undefined) {
      this.files.set(fileKey(existing.folderId ?? null, existing.name), {
        ...existing,
        byteSize: input.byteSize,
        sha256: input.sha256,
        versionNumber: 1,
        mimeType: input.mimeType ?? existing.mimeType,
      });
      this.content.set(input.objectId, input.content);
    }
    return {
      id: "66666666-6666-4666-8666-666666666666",
      orgId: input.orgId,
      objectId: input.objectId,
      versionNumber: 1,
      storageKey: `drive/${input.orgId}/${input.objectId}/v1/new.txt`,
      mimeType: input.mimeType ?? "text/plain",
      byteSize: input.byteSize,
      sha256: input.sha256 ?? "0".repeat(64),
      metadata: input.metadata ?? {},
      createdByActorId: input.actorId,
      createdAt: now,
    };
  }

  async list(input: Parameters<WebDavDriveStore["list"]>[0]): ReturnType<WebDavDriveStore["list"]> {
    const folderIdValue = input.folderId ?? null;
    const start = Number.parseInt(input.cursor ?? "0", 10);
    const limit = input.limit ?? 100;
    const entries = [
      ...this.folders.filter(
        (folder) =>
          folder.folderId === folderIdValue &&
          (input.includeTrashed === true || folder.deletedAt === null),
      ),
      ...[...this.files.values()].filter(
        (file) =>
          file.folderId === folderIdValue &&
          (input.includeTrashed === true || file.deletedAt === null),
      ),
    ];
    return {
      entries: entries.slice(start, start + limit),
      nextCursor: start + limit < entries.length ? String(start + limit) : null,
    };
  }

  async createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord> {
    const folder = folderEntry(
      input.name,
      "77777777-7777-4777-8777-777777777777",
      input.parentFolderId ?? null,
    );
    this.folders.push(folder);
    return folder;
  }

  async readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null> {
    const entry = [...this.files.values()].find((file) => file.id === input.objectId);
    if (entry === undefined) {
      return null;
    }
    return { entry, content: this.content.get(input.objectId) ?? null };
  }

  async delete(input: Parameters<WebDavDriveStore["delete"]>[0]): Promise<boolean> {
    this.deleted.push(input.objectId);
    for (const [name, file] of this.files.entries()) {
      if (file.id === input.objectId) {
        this.files.delete(name);
      }
    }
    return true;
  }

  async trash(input: Parameters<WebDavDriveStore["trash"]>[0]): Promise<DriveEntryRecord | null> {
    this.trashed.push(input.objectId);
    for (const [name, file] of this.files.entries()) {
      if (file.id === input.objectId) {
        const trashed = { ...file, deletedAt: now };
        this.files.set(name, trashed);
        return trashed;
      }
    }
    return null;
  }

  async trashFolder(
    input: Parameters<WebDavDriveStore["trashFolder"]>[0],
  ): Promise<DriveEntryRecord | null> {
    const index = this.folders.findIndex((folder) => folder.id === input.folderId);
    const folder = this.folders[index];
    if (folder === undefined) {
      return null;
    }
    const folderIds = new Set<string>([input.folderId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const candidate of this.folders) {
        if (
          candidate.folderId !== null &&
          folderIds.has(candidate.folderId) &&
          !folderIds.has(candidate.id)
        ) {
          folderIds.add(candidate.id);
          changed = true;
        }
      }
    }
    for (const [candidateIndex, candidate] of this.folders.entries()) {
      if (folderIds.has(candidate.id) && candidate.deletedAt === null) {
        this.folders[candidateIndex] = { ...candidate, deletedAt: now };
        this.trashedFolders.push(candidate.id);
      }
    }
    for (const [name, file] of this.files.entries()) {
      if (file.folderId !== null && folderIds.has(file.folderId) && file.deletedAt === null) {
        this.files.set(name, { ...file, deletedAt: now });
        this.trashed.push(file.id);
      }
    }
    return this.folders.find((candidate) => candidate.id === input.folderId) ?? null;
  }

  async share(input: Parameters<WebDavDriveStore["share"]>[0]) {
    return { objectId: input.objectId, sharedWithActorIds: input.targetActorIds, role: input.role };
  }

  async move(): Promise<DriveEntryRecord | null> {
    return null;
  }

  async restore(): Promise<DriveEntryRecord | null> {
    return null;
  }

  async search(): Promise<readonly DriveSearchHit[]> {
    return [];
  }
}

function folderEntry(name: string, id: string, parentId: string | null): DriveEntryRecord {
  return {
    id,
    type: "folder",
    name,
    folderId: parentId,
    ownerActorId: actorId,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function fileEntry(input: {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly folderId?: string | null;
  readonly byteSize?: number;
  readonly sha256?: string | null;
  readonly mimeType?: string;
}): DriveEntryRecord {
  const content = Buffer.from(input.content);
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: input.folderId ?? null,
    ownerActorId: actorId,
    mimeType: input.mimeType ?? "text/plain",
    byteSize: input.byteSize ?? content.byteLength,
    sha256: input.sha256 ?? createHash("sha256").update(content).digest("hex"),
    storageKey: `drive/${orgId}/${input.id}/v1/${input.name}`,
    versionNumber: 1,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function fileKey(folderIdValue: string | null, name: string): string {
  return `${folderIdValue ?? "root"}:${name}`;
}
