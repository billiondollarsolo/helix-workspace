import type { Actor } from "@helix/sdk-types";
import type { DriveStore } from "./store.js";
import type { DriveEntryRecord } from "./types.js";

/**
 * Path-style access to the Drive folder tree, shared by the protocol gateways
 * (WebDAV and the S3-compatible API). Every lookup goes through
 * `DriveStore.list`, so folder ACLs, tenant RLS, and upload/scan visibility are
 * exactly what the REST API enforces.
 */
export type DrivePathStore = Pick<DriveStore, "list">;

/** Root-only Drive views: `owned` is My Drive, `shared` is Shared with me. */
export type DriveRootView = "owned" | "shared";

export interface ResolvedDrivePath {
  readonly kind: "folder" | "file";
  readonly folderId: string | null;
  readonly entry?: DriveEntryRecord;
  readonly path: readonly string[];
}

/** Files that are still uploading, scanning, or quarantined cannot be downloaded,
 * so protocol listings omit them instead of advertising a GET that fails. */
export function isDriveEntryListable(entry: DriveEntryRecord): boolean {
  return entry.type === "folder" || entry.available !== false;
}

export async function resolveDrivePath(
  store: DrivePathStore,
  actor: Actor,
  path: readonly string[],
  rootView?: DriveRootView,
): Promise<ResolvedDrivePath | null> {
  if (path.length === 0) {
    return { kind: "folder", folderId: null, path };
  }
  const parent = await resolveDriveParentFolder(store, actor, path, rootView);
  if (parent === null) {
    return null;
  }
  const name = path.at(-1);
  if (name === undefined) {
    return parent;
  }
  const child = await findDriveChild(
    store,
    actor,
    parent.folderId,
    name,
    parent.folderId === null ? rootView : undefined,
  );
  if (child === null) {
    return null;
  }
  return {
    kind: child.type,
    folderId: child.type === "folder" ? child.id : parent.folderId,
    entry: child,
    path,
  };
}

export async function resolveDriveParentFolder(
  store: DrivePathStore,
  actor: Actor,
  path: readonly string[],
  rootView?: DriveRootView,
): Promise<ResolvedDrivePath | null> {
  let folderId: string | null = null;
  const parentSegments = path.slice(0, -1);
  for (const segment of parentSegments) {
    const child = await findDriveChild(
      store,
      actor,
      folderId,
      segment,
      folderId === null ? rootView : undefined,
    );
    if (child === null || child.type !== "folder") {
      return null;
    }
    folderId = child.id;
  }
  return { kind: "folder", folderId, path: parentSegments };
}

export async function findDriveChild(
  store: DrivePathStore,
  actor: Actor,
  folderId: string | null,
  name: string,
  view?: DriveRootView,
): Promise<DriveEntryRecord | null> {
  let cursor: string | undefined;
  do {
    const page = await store.list({
      orgId: actor.orgId,
      actorId: actor.id,
      folderId,
      limit: 250,
      ...(view === undefined ? {} : { view }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const found = page.entries.find((entry) => entry.name === name);
    if (found !== undefined) return found;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return null;
}

/** Every listable child of a folder (or of the Drive root), across list pages. */
export async function listDriveChildren(
  store: DrivePathStore,
  actor: Actor,
  folderId: string | null,
  view?: DriveRootView,
): Promise<readonly DriveEntryRecord[]> {
  const entries: DriveEntryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({
      orgId: actor.orgId,
      actorId: actor.id,
      folderId,
      limit: 250,
      ...(view === undefined ? {} : { view }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.entries.filter(isDriveEntryListable));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return entries;
}
