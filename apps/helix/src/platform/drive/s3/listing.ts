import type { Actor } from "@helix/sdk-types";
import { listDriveChildren, resolveDrivePath, type DrivePathStore } from "../path-resolution.js";
import type { DriveEntryRecord } from "../types.js";
import { compareS3Keys, type DriveS3Bucket } from "./buckets.js";

/**
 * ListObjects over the Drive tree. Keys are '/'-joined Drive paths and are
 * produced in S3's UTF-8 binary order by walking each folder's children
 * sorted by `name` (files) or `name/` (folders). Folders that collapse into a
 * CommonPrefix, or that sort entirely before the resume marker, are never
 * listed, so a delimiter listing reads one folder and pagination resumes
 * without re-reading earlier subtrees.
 */
interface DriveS3ListedObject {
  readonly key: string;
  readonly entry: DriveEntryRecord;
}

export interface DriveS3ListResult {
  readonly contents: readonly DriveS3ListedObject[];
  readonly commonPrefixes: readonly string[];
  readonly isTruncated: boolean;
  /** The last key or common prefix returned; resume marker for the next page. */
  readonly lastReturned?: string;
}

export interface DriveS3ListInput {
  readonly prefix: string;
  readonly delimiter?: string;
  /** Exclusive lower bound (StartAfter, Marker, or a decoded continuation token). */
  readonly after?: string;
  readonly maxKeys: number;
}

type ListNode =
  | { readonly kind: "object"; readonly key: string; readonly entry: DriveEntryRecord }
  | { readonly kind: "prefix"; readonly prefix: string };

export async function listDriveS3Objects(
  store: DrivePathStore,
  actor: Actor,
  bucket: DriveS3Bucket,
  input: DriveS3ListInput,
): Promise<DriveS3ListResult> {
  const contents: DriveS3ListedObject[] = [];
  const commonPrefixes: string[] = [];
  if (input.maxKeys <= 0) return { contents, commonPrefixes, isTruncated: false };
  // Start at the deepest folder the prefix names completely.
  const startSegments = input.prefix.split("/").slice(0, -1);
  if (startSegments.some((segment) => segment.length === 0)) {
    return { contents, commonPrefixes, isTruncated: false };
  }
  const start = await resolveDrivePath(store, actor, startSegments, bucket.view);
  if (start === null || start.kind !== "folder") {
    return { contents, commonPrefixes, isTruncated: false };
  }
  let lastReturned: string | undefined;
  for await (const node of walk(store, actor, bucket, start.folderId, startSegments, input)) {
    if (contents.length + commonPrefixes.length >= input.maxKeys) {
      return {
        contents,
        commonPrefixes,
        isTruncated: true,
        ...(lastReturned === undefined ? {} : { lastReturned }),
      };
    }
    if (node.kind === "object") {
      contents.push({ key: node.key, entry: node.entry });
      lastReturned = node.key;
    } else {
      commonPrefixes.push(node.prefix);
      lastReturned = node.prefix;
    }
  }
  return {
    contents,
    commonPrefixes,
    isTruncated: false,
    ...(lastReturned === undefined ? {} : { lastReturned }),
  };
}

async function* walk(
  store: DrivePathStore,
  actor: Actor,
  bucket: DriveS3Bucket,
  folderId: string | null,
  path: readonly string[],
  input: DriveS3ListInput,
  emitted: Set<string> = new Set(),
): AsyncGenerator<ListNode> {
  const children = await listDriveChildren(
    store,
    actor,
    folderId,
    folderId === null ? bucket.view : undefined,
  );
  const base = path.length === 0 ? "" : `${path.join("/")}/`;
  const ordered = children
    .map((entry) => ({
      entry,
      key: entry.type === "folder" ? `${base}${entry.name}/` : `${base}${entry.name}`,
    }))
    .sort((left, right) => compareS3Keys(left.key, right.key));
  for (const { entry, key } of ordered) {
    if (entry.type === "folder") {
      const keyPrefix = key;
      if (!keyPrefix.startsWith(input.prefix) && !input.prefix.startsWith(keyPrefix)) continue;
      if (input.after !== undefined && sortsWhollyBefore(keyPrefix, input.after)) continue;
      const collapsed = commonPrefixFor(keyPrefix, input);
      if (collapsed !== undefined) {
        if (!emitted.has(collapsed) && !isResumedPast(collapsed, input.after)) {
          emitted.add(collapsed);
          yield { kind: "prefix", prefix: collapsed };
        }
        continue;
      }
      yield* walk(store, actor, bucket, entry.id, [...path, entry.name], input, emitted);
      continue;
    }
    if (!key.startsWith(input.prefix)) continue;
    if (input.after !== undefined && compareS3Keys(key, input.after) <= 0) continue;
    const collapsed = commonPrefixFor(key, input);
    if (collapsed !== undefined) {
      if (!emitted.has(collapsed) && !isResumedPast(collapsed, input.after)) {
        emitted.add(collapsed);
        yield { kind: "prefix", prefix: collapsed };
      }
      continue;
    }
    yield { kind: "object", key, entry };
  }
}

/** The CommonPrefix a key (or a folder's key prefix) rolls up into, if any. */
function commonPrefixFor(key: string, input: DriveS3ListInput): string | undefined {
  if (input.delimiter === undefined || input.delimiter.length === 0) return undefined;
  if (!key.startsWith(input.prefix)) return undefined;
  const rest = key.slice(input.prefix.length);
  const index = rest.indexOf(input.delimiter);
  return index < 0 ? undefined : input.prefix + rest.slice(0, index + input.delimiter.length);
}

/** Every key under `keyPrefix` sorts at or before `after`. */
function sortsWhollyBefore(keyPrefix: string, after: string): boolean {
  return !after.startsWith(keyPrefix) && compareS3Keys(keyPrefix, after) < 0;
}

/** A common prefix already returned on an earlier page (S3 resumes past it). */
function isResumedPast(prefix: string, after: string | undefined): boolean {
  return after !== undefined && (compareS3Keys(prefix, after) <= 0 || after.startsWith(prefix));
}
