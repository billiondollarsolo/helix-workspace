import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { DrivePathStore } from "../path-resolution.js";
import type { DriveEntryRecord } from "../types.js";
import { DRIVE_S3_BUCKETS, parseDriveS3Key, resolveDriveS3Bucket } from "./buckets.js";
import { S3Error } from "./errors.js";
import { listDriveS3Objects } from "./listing.js";
import { classifyDriveS3Operation } from "./operations.js";
import { parseDriveS3Target } from "./request.js";

const actor: Actor = { id: "actor", orgId: "org", type: "user" };
const at = new Date("2026-10-11T00:00:00Z");

/** A folder tree: path -> children. `/` suffix marks folders. */
function treeStore(tree: Record<string, readonly string[]>): {
  store: DrivePathStore;
  listedFolders: (string | null)[];
} {
  const listedFolders: (string | null)[] = [];
  const store: DrivePathStore = {
    async list(input) {
      const folderId = input.folderId ?? null;
      listedFolders.push(folderId);
      const children = tree[folderId ?? ""] ?? [];
      const entries: DriveEntryRecord[] = children.map((name) => {
        const folder = name.endsWith("/");
        const clean = folder ? name.slice(0, -1) : name;
        const id = `${folderId ?? ""}/${clean}`;
        return {
          id,
          type: folder ? "folder" : "file",
          name: clean,
          folderId,
          ownerActorId: "actor",
          byteSize: folder ? undefined : 1,
          sha256: folder ? undefined : "a".repeat(64),
          metadata: {},
          deletedAt: null,
          createdAt: at,
          updatedAt: at,
        };
      });
      return { entries, nextCursor: null };
    },
  };
  return { store, listedFolders };
}

const tree = {
  "": ["a-b", "a/", "b.txt", "z/"],
  "/a": ["x.txt", "sub/", "y.txt"],
  "/a/sub": ["deep.txt"],
  "/z": [],
};

describe("listDriveS3Objects", () => {
  const bucket = DRIVE_S3_BUCKETS["my-drive"];

  it("lists recursively in UTF-8 binary key order", async () => {
    const { store } = treeStore(tree);
    const result = await listDriveS3Objects(store, actor, bucket, { prefix: "", maxKeys: 100 });
    expect(result.contents.map((entry) => entry.key)).toEqual([
      "a-b",
      "a/sub/deep.txt",
      "a/x.txt",
      "a/y.txt",
      "b.txt",
    ]);
    expect(result.isTruncated).toBe(false);
  });

  it("rolls folders into common prefixes without reading them", async () => {
    const { store, listedFolders } = treeStore(tree);
    const result = await listDriveS3Objects(store, actor, bucket, {
      prefix: "",
      delimiter: "/",
      maxKeys: 100,
    });
    expect(result.contents.map((entry) => entry.key)).toEqual(["a-b", "b.txt"]);
    expect(result.commonPrefixes).toEqual(["a/", "z/"]);
    expect(listedFolders).toEqual([null]);
  });

  it("starts at the folder a prefix names and filters partial names", async () => {
    const { store } = treeStore(tree);
    const result = await listDriveS3Objects(store, actor, bucket, {
      prefix: "a/s",
      delimiter: "/",
      maxKeys: 100,
    });
    expect(result.commonPrefixes).toEqual(["a/sub/"]);
    expect(result.contents).toEqual([]);
  });

  it("paginates and resumes after the marker, skipping earlier subtrees", async () => {
    const { store } = treeStore(tree);
    const first = await listDriveS3Objects(store, actor, bucket, { prefix: "", maxKeys: 2 });
    expect(first.contents.map((entry) => entry.key)).toEqual(["a-b", "a/sub/deep.txt"]);
    expect(first.isTruncated).toBe(true);
    const tracked = treeStore(tree);
    const second = await listDriveS3Objects(tracked.store, actor, bucket, {
      prefix: "",
      maxKeys: 2,
      after: first.lastReturned ?? "",
    });
    expect(second.contents.map((entry) => entry.key)).toEqual(["a/x.txt", "a/y.txt"]);
    const third = await listDriveS3Objects(store, actor, bucket, {
      prefix: "",
      maxKeys: 2,
      after: "a/y.txt",
    });
    expect(third.contents.map((entry) => entry.key)).toEqual(["b.txt"]);
    expect(third.isTruncated).toBe(false);
  });

  it("does not repeat a common prefix returned on an earlier page", async () => {
    const { store } = treeStore(tree);
    const result = await listDriveS3Objects(store, actor, bucket, {
      prefix: "",
      delimiter: "/",
      maxKeys: 100,
      after: "a/",
    });
    expect(result.commonPrefixes).toEqual(["z/"]);
    expect(result.contents.map((entry) => entry.key)).toEqual(["b.txt"]);
  });
});

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof S3Error) return error.code;
    throw error;
  }
  return "none";
}

describe("bucket and key mapping", () => {
  it("resolves canonical buckets and tenant-qualified aliases", () => {
    expect(resolveDriveS3Bucket("my-drive", "acme").view).toBe("owned");
    expect(resolveDriveS3Bucket("acme--shared-with-me", "acme").name).toBe("shared-with-me");
    expect(code(() => resolveDriveS3Bucket("other--my-drive", "acme"))).toBe("AccessDenied");
    expect(code(() => resolveDriveS3Bucket("photos", "acme"))).toBe("NoSuchBucket");
    expect(code(() => resolveDriveS3Bucket("Bad_Bucket", "acme"))).toBe("InvalidBucketName");
  });

  it("maps keys onto Drive path segments", () => {
    expect(parseDriveS3Key("a/b/c.txt").segments).toEqual(["a", "b", "c.txt"]);
    expect(parseDriveS3Key("a/b/")).toMatchObject({ directory: true, segments: ["a", "b"] });
    for (const bad of ["a//b", "../x", "a/./b", "x".repeat(256), "a\u0000b"]) {
      expect(code(() => parseDriveS3Key(bad))).toBe("InvalidObjectName");
    }
    expect(code(() => parseDriveS3Key("k".repeat(1025)))).toBe("KeyTooLongError");
  });
});

describe("operation classification", () => {
  const classify = (method: string, url: string, headers: Record<string, string> = {}) =>
    classifyDriveS3Operation(method, parseDriveS3Target(url), headers);

  it("routes the supported S3 API with the scope it needs", () => {
    const cases: [string, string, string, string][] = [
      ["GET", "/s3", "ListBuckets", "drive.read"],
      ["HEAD", "/s3/my-drive", "HeadBucket", "drive.read"],
      ["GET", "/s3/my-drive?list-type=2&prefix=a", "ListObjectsV2", "drive.read"],
      ["GET", "/s3/my-drive?marker=a", "ListObjects", "drive.read"],
      ["GET", "/s3/my-drive?location", "GetBucketLocation", "drive.read"],
      ["POST", "/s3/my-drive?delete", "DeleteObjects", "drive.delete"],
      ["GET", "/s3/my-drive/a%20b.txt?x-id=GetObject", "GetObject", "drive.read"],
      ["PUT", "/s3/my-drive/a.txt", "PutObject", "drive.write"],
      ["DELETE", "/s3/my-drive/a.txt", "DeleteObject", "drive.delete"],
      ["POST", "/s3/my-drive/a.txt?uploads", "CreateMultipartUpload", "drive.write"],
      ["PUT", "/s3/my-drive/a.txt?partNumber=1&uploadId=u", "UploadPart", "drive.write"],
      ["POST", "/s3/my-drive/a.txt?uploadId=u", "CompleteMultipartUpload", "drive.write"],
      ["DELETE", "/s3/my-drive/a.txt?uploadId=u", "AbortMultipartUpload", "drive.write"],
      ["GET", "/s3/my-drive/a.txt?uploadId=u", "ListParts", "drive.read"],
    ];
    for (const [method, url, name, scope] of cases) {
      expect(classify(method, url)).toMatchObject({ name, scope });
    }
    expect(
      classify("PUT", "/s3/my-drive/b.txt", { "x-amz-copy-source": "my-drive/a.txt" }).name,
    ).toBe("CopyObject");
    expect(parseDriveS3Target("/s3/my-drive/a%20b/c.txt").key).toBe("a b/c.txt");
  });

  it("answers unsupported subresources with NotImplemented", () => {
    for (const url of ["/s3/my-drive?acl", "/s3/my-drive/a.txt?tagging", "/s3/my-drive?policy"]) {
      expect(code(() => classify("GET", url))).toBe("NotImplemented");
    }
    expect(code(() => classify("GET", "/s3/my-drive/a.txt?versionId=v2"))).toBe("NotImplemented");
    expect(code(() => classify("DELETE", "/s3/my-drive"))).toBe("NotImplemented");
  });
});
