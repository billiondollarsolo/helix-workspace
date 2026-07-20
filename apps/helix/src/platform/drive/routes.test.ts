import { createHash } from "node:crypto";
import fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { ApiError } from "../../api/api-error.js";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import {
  registerDriveRoutes,
  registerDriveShareLinkRoute,
  type WebDavDriveStore,
} from "./routes.js";

/** Minimal envelope handler so isolated route tests match production G4 rendering. */
function withApiErrorHandler(app: FastifyInstance): FastifyInstance {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    throw error;
  });
  return app;
}
import type {
  DriveFileReadInput,
  DriveFileReadResult,
  DriveFolderCreateInput,
  FinalizeDriveUploadInput,
  PrepareDriveUploadInput,
} from "./store.js";
import type {
  DriveEntryRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
} from "./types.js";

const now = new Date("2026-05-20T12:00:00.000Z");
const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const emptyFolderId = "33333333-3333-4333-8333-333333333334";
const nestedFolderId = "33333333-3333-4333-8333-333333333335";
const reportId = "44444444-4444-4444-8444-444444444444";
const uploadId = "55555555-5555-4555-8555-555555555555";

describe("Drive WebDAV routes", () => {
  it("advertises WebDAV methods and challenges unauthenticated clients", async () => {
    const app = fastify();
    await registerDriveRoutes(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const options = await app.inject({ method: "OPTIONS", url: "/dav/files/" });
    const propfind = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/",
    } as unknown as InjectOptions);

    expect(options.statusCode).toBe(204);
    expect(options.headers.dav).toBe("1, 2");
    expect(options.headers.allow).toContain("MKCOL");
    expect(options.headers.allow).toContain("LOCK");
    expect(options.headers.allow).toContain("UNLOCK");
    expect(propfind.statusCode).toBe(401);
    expect(propfind.headers["www-authenticate"]).toBe('Basic realm="Helix WebDAV"');
  });

  it("returns root collection and child metadata for PROPFIND depth 1", async () => {
    const app = fastify();
    await registerDriveRoutes(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const response = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/",
      headers: {
        authorization: basic("ada@example.test", "read"),
        depth: "1",
      },
    } as unknown as InjectOptions);

    expect(response.statusCode).toBe(207);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(response.body).toContain("<D:href>/dav/files/</D:href>");
    expect(response.body).toContain("<D:displayname>Projects</D:displayname>");
    expect(response.body).toContain("<D:displayname>report.txt</D:displayname>");
    expect(response.body).toContain("<D:getcontenttype>text/plain</D:getcontenttype>");
    expect(response.body).toContain("<D:supportedlock>");
    expect(response.body).toContain("<D:lockscope><D:exclusive/></D:lockscope>");
    expect(response.body).toContain("<D:lockdiscovery/>");
    expect(response.body).toContain("<D:quota-used-bytes>0</D:quota-used-bytes>");
    expect(response.body).toContain("<D:quota-available-bytes>10995116277760</D:quota-available-bytes>");
  });

  it("filters requested PROPFIND properties and reports unsupported properties in multistatus", async () => {
    const app = fastify();
    await registerDriveRoutes(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const filtered = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "read"),
        "content-type": "application/xml",
        depth: "0",
      },
      payload:
        '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getcontentlength/></D:prop></D:propfind>',
    } as unknown as InjectOptions);
    const unsupported = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "read"),
        "content-type": "application/xml",
        depth: "0",
      },
      payload:
        '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:made-up/></D:prop></D:propfind>',
    } as unknown as InjectOptions);

    expect(filtered.statusCode).toBe(207);
    expect(filtered.body).toContain("<D:getetag>");
    expect(filtered.body).toContain("<D:getcontentlength>16</D:getcontentlength>");
    expect(filtered.body).not.toContain("<D:displayname>");
    expect(filtered.body).not.toContain("<D:resourcetype>");
    expect(filtered.body).not.toContain("<D:getcontenttype>");
    expect(unsupported.statusCode).toBe(207);
    expect(unsupported.body).toContain("<D:getetag>");
    expect(unsupported.body).toContain("HTTP/1.1 200 OK");
    expect(unsupported.body).toContain("<D:made-up/>");
    expect(unsupported.body).toContain("HTTP/1.1 404 Not Found");
  });

  it("supports PROPFIND propname and text/xml request bodies", async () => {
    const app = fastify();
    await registerDriveRoutes(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const propname = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "read"),
        "content-type": "application/xml",
        depth: "0",
      },
      payload: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
    } as unknown as InjectOptions);
    const textXml = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "read"),
        "content-type": "text/xml",
        depth: "0",
      },
      payload:
        '<D:propfind xmlns:D="DAV:"><D:prop><D:supportedlock/><D:lockdiscovery/></D:prop></D:propfind>',
    } as unknown as InjectOptions);

    expect(propname.statusCode).toBe(207);
    expect(propname.body).toContain("<D:getetag/>");
    expect(propname.body).toContain("<D:getcontentlength/>");
    expect(propname.body).not.toContain("quarterly report");
    expect(textXml.statusCode).toBe(207);
    expect(textXml.body).toContain("<D:supportedlock>");
    expect(textXml.body).toContain("<D:lockdiscovery/>");
    expect(textXml.body).not.toContain("HTTP/1.1 404 Not Found");
  });

  it("uploads, downloads, creates folders, and deletes files with method-scoped app passwords", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const blockedPut = await app.inject({
      method: "PUT",
      url: "/dav/files/new.txt",
      headers: { authorization: basic("ada@example.test", "read"), "content-type": "text/plain" },
      payload: "hello",
    });
    const createdFolder = await app.inject({
      method: "MKCOL",
      url: "/dav/files/Notes",
      headers: { authorization: basic("ada@example.test", "write") },
    } as unknown as InjectOptions);
    const createdFile = await app.inject({
      method: "PUT",
      url: "/dav/files/new.txt",
      headers: { authorization: basic("ada@example.test", "write"), "content-type": "text/plain" },
      payload: "hello webdav",
    });
    const downloaded = await app.inject({
      method: "GET",
      url: "/dav/files/new.txt",
      headers: { authorization: basic("ada@example.test", "read") },
    });
    const blockedDelete = await app.inject({
      method: "DELETE",
      url: "/dav/files/new.txt",
      headers: { authorization: basic("ada@example.test", "write") },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/dav/files/new.txt",
      headers: { authorization: basic("ada@example.test", "delete") },
    });

    expect(blockedPut.statusCode).toBe(401);
    expect(createdFolder.statusCode).toBe(201);
    expect(store.folders.map((folder) => folder.name)).toContain("Notes");
    expect(createdFile.statusCode).toBe(201);
    expect(store.uploads[0]).toMatchObject({
      orgId,
      actorId,
      name: "new.txt",
      mimeType: "text/plain",
      byteSize: 12,
    });
    expect(store.finalized[0]).toMatchObject({
      orgId,
      actorId,
      objectId: uploadId,
      byteSize: 12,
      sha256: createHash("sha256").update("hello webdav").digest("hex"),
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("text/plain");
    expect(downloaded.body).toBe("hello webdav");
    expect(blockedDelete.statusCode).toBe(401);
    expect(deleted.statusCode).toBe(204);
    expect(store.trashed).toEqual([uploadId]);
  });

  it("preserves nested collection paths in PROPFIND hrefs and MKCOL locations", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const propfind = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/Projects/",
      headers: {
        authorization: basic("ada@example.test", "read"),
        depth: "1",
      },
    } as unknown as InjectOptions);
    const createdNestedFolder = await app.inject({
      method: "MKCOL",
      url: "/dav/files/Projects/Plans",
      headers: { authorization: basic("ada@example.test", "write") },
    } as unknown as InjectOptions);
    const createdNestedFile = await app.inject({
      method: "PUT",
      url: "/dav/files/Projects/brief.txt",
      headers: { authorization: basic("ada@example.test", "write"), "content-type": "text/plain" },
      payload: "project brief",
    });
    const downloadedNestedFile = await app.inject({
      method: "GET",
      url: "/dav/files/Projects/roadmap.md",
      headers: { authorization: basic("ada@example.test", "read") },
    });

    expect(propfind.statusCode).toBe(207);
    expect(propfind.body).toContain("<D:href>/dav/files/Projects/</D:href>");
    expect(propfind.body).toContain("<D:href>/dav/files/Projects/roadmap.md</D:href>");
    expect(propfind.body).not.toContain("<D:href>/dav/files/roadmap.md</D:href>");
    expect(createdNestedFolder.statusCode).toBe(201);
    expect(createdNestedFolder.headers.location).toBe("/dav/files/Projects/Plans/");
    expect(createdNestedFile.statusCode).toBe(201);
    expect(store.uploads.at(-1)).toMatchObject({
      name: "brief.txt",
      folderId,
    });
    expect(downloadedNestedFile.statusCode).toBe(200);
    expect(downloadedNestedFile.body).toBe("roadmap");
  });

  it("enforces WebDAV PUT ETag preconditions", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const createOnlyConflict = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
        "if-none-match": "*",
      },
      payload: "replacement",
    });
    const missingIfMatch = await app.inject({
      method: "PUT",
      url: "/dav/files/missing.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
        "if-match": "*",
      },
      payload: "new file",
    });
    const staleIfMatch = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
        "if-match": '"stale"',
      },
      payload: "replacement",
    });
    const currentIfMatch = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
        "if-match": `"${reportId}-1-${createHash("sha256").update("quarterly report").digest("hex")}"`,
      },
      payload: "replacement",
    });

    expect(createOnlyConflict.statusCode).toBe(412);
    expect(missingIfMatch.statusCode).toBe(412);
    expect(staleIfMatch.statusCode).toBe(412);
    expect(currentIfMatch.statusCode).toBe(204);
    expect(store.finalized.at(-1)).toMatchObject({
      byteSize: 11,
      sha256: createHash("sha256").update("replacement").digest("hex"),
    });
  });

  it("supports exclusive WebDAV LOCK and UNLOCK tokens for mutations", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const locked = await app.inject({
      method: "LOCK",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        depth: "0",
        timeout: "Second-60",
        "content-type": "application/xml",
      },
      payload:
        '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>helix-test</D:href></D:owner></D:lockinfo>',
    } as unknown as InjectOptions);
    const lockToken = String(locked.headers["lock-token"]);
    const propfindLocked = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "read"),
        "content-type": "application/xml",
        depth: "0",
      },
      payload: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
    } as unknown as InjectOptions);
    const blockedPut = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
      },
      payload: "blocked",
    });
    const tokenPut = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        if: `(${lockToken})`,
        "content-type": "text/plain",
      },
      payload: "replacement",
    });
    const wrongUnlock = await app.inject({
      method: "UNLOCK",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "lock-token": "<opaquelocktoken:wrong>",
      },
    } as unknown as InjectOptions);
    const unlocked = await app.inject({
      method: "UNLOCK",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "lock-token": lockToken,
      },
    } as unknown as InjectOptions);
    const releasedPut = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
      },
      payload: "released",
    });

    expect(locked.statusCode).toBe(200);
    expect(lockToken).toContain("opaquelocktoken:");
    expect(locked.body).toContain("<D:lockdiscovery>");
    expect(locked.body).toContain("<D:activelock>");
    expect(locked.body).toContain("helix-test");
    expect(propfindLocked.statusCode).toBe(207);
    expect(propfindLocked.body).toContain("<D:activelock>");
    expect(propfindLocked.body).toContain(lockToken.replace(/^<|>$/gu, ""));
    expect(blockedPut.statusCode).toBe(423);
    expect(tokenPut.statusCode).toBe(204);
    expect(wrongUnlock.statusCode).toBe(409);
    expect(unlocked.statusCode).toBe(204);
    expect(releasedPut.statusCode).toBe(204);
  });

  it("supports lock-null WebDAV create flows and rejects conflicting locks", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const lockNull = await app.inject({
      method: "LOCK",
      url: "/dav/files/draft.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "application/xml",
      },
      payload:
        '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    } as unknown as InjectOptions);
    const token = String(lockNull.headers["lock-token"]);
    const conflict = await app.inject({
      method: "LOCK",
      url: "/dav/files/draft.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "application/xml",
      },
      payload:
        '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    } as unknown as InjectOptions);
    const refreshed = await app.inject({
      method: "LOCK",
      url: "/dav/files/draft.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        if: `(${token})`,
        timeout: "Second-300",
      },
    } as unknown as InjectOptions);
    const blockedPut = await app.inject({
      method: "PUT",
      url: "/dav/files/draft.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
      },
      payload: "draft",
    });
    const created = await app.inject({
      method: "PUT",
      url: "/dav/files/draft.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        if: `(${token})`,
        "content-type": "text/plain",
      },
      payload: "draft",
    });

    expect(lockNull.statusCode).toBe(201);
    expect(token).toContain("opaquelocktoken:");
    expect(conflict.statusCode).toBe(423);
    expect(refreshed.statusCode).toBe(201);
    expect(refreshed.headers["lock-token"]).toBe(token);
    expect(blockedPut.statusCode).toBe(423);
    expect(created.statusCode).toBe(201);
    expect(store.uploads.at(-1)).toMatchObject({ name: "draft.txt", byteSize: 5 });
  });

  it("uses Drive trash semantics for recursive WebDAV deletes", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const rootDelete = await app.inject({
      method: "DELETE",
      url: "/dav/files/",
      headers: { authorization: basic("ada@example.test", "delete") },
    });
    const nonEmptyFolderDelete = await app.inject({
      method: "DELETE",
      url: "/dav/files/Projects/",
      headers: { authorization: basic("ada@example.test", "delete") },
    });
    const emptyFolderDelete = await app.inject({
      method: "DELETE",
      url: "/dav/files/Empty/",
      headers: { authorization: basic("ada@example.test", "delete") },
    });
    const deletedFolderPropfind = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/Projects/",
      headers: { authorization: basic("ada@example.test", "read") },
    } as unknown as InjectOptions);

    expect(rootDelete.statusCode).toBe(405);
    expect(nonEmptyFolderDelete.statusCode).toBe(204);
    expect(emptyFolderDelete.statusCode).toBe(204);
    expect(deletedFolderPropfind.statusCode).toBe(404);
    expect(store.trashedFolders).toEqual([folderId, nestedFolderId, emptyFolderId]);
    expect(store.trashed).toEqual([
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
    ]);
  });
});

describe("Drive public share-link route", () => {
  it("streams content for a valid token without session auth", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        readFileByShareToken: async (token) => {
          if (token !== "goodtoken") {
            return null;
          }
          return {
            entry: fileEntry({
              id: reportId,
              name: "shared-report.txt",
              content: "public bytes",
            }),
            content: Buffer.from("public bytes"),
          };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/goodtoken",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("public bytes");
    expect(String(response.headers["content-disposition"] ?? "")).toContain("shared-report.txt");
  });

  it("supports Range requests on share-link content", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        readFileByShareToken: async () => ({
          entry: fileEntry({
            id: reportId,
            name: "shared-report.txt",
            content: "public bytes",
          }),
          content: Buffer.from("public bytes"),
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/goodtoken",
      headers: { range: "bytes=0-5" },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 0-5/12");
    expect(response.body).toBe("public");
  });

  it("returns 404 for unknown/revoked/expired tokens", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        readFileByShareToken: async () => null,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/missing-token",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "not_found", message: "Share link not found." },
    });
  });

  it("returns metadata when content bytes are unavailable", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        readFileByShareToken: async () => ({
          entry: fileEntry({
            id: reportId,
            name: "pending.bin",
            content: "",
            mimeType: "application/octet-stream",
          }),
          content: null,
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/pending-token",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      objectId: reportId,
      name: "pending.bin",
      contentAvailable: false,
    });
  });
});

class FakeAppPasswordAuthenticator implements AppPasswordAuthenticator {
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

class FakeWebDavDriveStore implements WebDavDriveStore {
  readonly uploads: PrepareDriveUploadInput[] = [];
  readonly finalized: FinalizeDriveUploadInput[] = [];
  readonly deleted: string[] = [];
  readonly trashed: string[] = [];
  readonly trashedFolders: string[] = [];
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

  async prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord> {
    this.uploads.push(input);
    const entry = fileEntry({
      id: uploadId,
      name: input.name,
      content: "",
      folderId: input.folderId ?? null,
      byteSize: input.byteSize ?? 0,
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
      byteSize: input.byteSize ?? 0,
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
      storageKey: input.storageKey ?? `drive/${input.orgId}/${input.objectId}/v1/new.txt`,
      mimeType: input.mimeType ?? "text/plain",
      byteSize: input.byteSize,
      sha256: input.sha256,
      metadata: input.metadata ?? {},
      createdByActorId: input.actorId,
      createdAt: now,
    };
  }

  async list(input: Parameters<WebDavDriveStore["list"]>[0]): Promise<readonly DriveEntryRecord[]> {
    const folderIdValue = input.folderId ?? null;
    return [
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
    for (let changed = true; changed; ) {
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
    app: null,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fileEntry(input: {
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
    app: null,
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

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function fileKey(folderIdValue: string | null, name: string): string {
  return `${folderIdValue ?? "root"}:${name}`;
}
