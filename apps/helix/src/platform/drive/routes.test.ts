import {
  orgId,
  actorId,
  folderId,
  emptyFolderId,
  nestedFolderId,
  reportId,
  uploadId,
  FakeAppPasswordAuthenticator,
  FakeWebDavDriveStore,
  fileEntry,
  basic,
} from "../../test-support/webdav-drive.js";
import fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import {
  registerDriveRoutes as registerDriveRoutesStrict,
  registerDriveShareLinkRoute,
  type RegisterDriveRoutesOptions,
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

function registerDriveRoutes(
  app: FastifyInstance,
  options: RegisterDriveRoutesOptions,
): Promise<void> {
  return registerDriveRoutesStrict(app, { ...options, requireTls: false });
}

describe("Drive WebDAV routes", () => {
  it("maps malformed PROPFIND XML to a bounded client error", async () => {
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
        "content-type": "application/xml",
      },
      payload: '<D:propfind xmlns:D="DAV:"><D:prop></D:propfind>',
    } as unknown as InjectOptions);
    expect(response.statusCode).toBe(400);
  });

  it("advertises only implemented methods and the implemented sync compliance token", async () => {
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
    expect(options.headers.dav).toBe("sync-collection");
    expect(options.headers.allow).toContain("MKCOL");
    expect(options.headers.allow).toContain("LOCK");
    expect(options.headers.allow).toContain("UNLOCK");
    expect(options.headers.allow).toContain("REPORT");
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
    expect(response.body).toContain("<D:href>/v1/dav/files/</D:href>");
    expect(response.body).toContain("<D:displayname>Projects</D:displayname>");
    expect(response.body).toContain("<D:displayname>report.txt</D:displayname>");
    expect(response.body).toContain("<D:getcontenttype>text/plain</D:getcontenttype>");
    expect(response.body).toContain("<D:supportedlock>");
    expect(response.body).toContain("<D:supported-report-set>");
    expect(response.body).toContain("<D:sync-token>urn:helix:webdav-sync:");
    expect(response.body).toContain("<D:lockscope><D:exclusive/></D:lockscope>");
    expect(response.body).toContain("<D:lockdiscovery/>");
    expect(response.body).not.toContain("<D:quota-used-bytes>");
    expect(response.body).not.toContain("<D:quota-available-bytes>");
  });

  it.each([
    { limit: null, used: 450, available: null },
    { limit: 1000, used: 450, available: 550 },
    { limit: 400, used: 450, available: 0 },
  ])("reports measured quota $limit / $used", async ({ limit, used, available }) => {
    const store = Object.assign(new FakeWebDavDriveStore(), {
      getStorageQuotaUsage: async () => ({
        orgId,
        limitBytes: limit,
        usedBytes: used,
        unlimited: limit === null,
        percentUsed: null,
      }),
    });
    const app = fastify();
    await registerDriveRoutes(app, { store, appPasswords: new FakeAppPasswordAuthenticator() });
    const response = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/",
      headers: { authorization: basic("ada@example.test", "read"), depth: "0" },
    } as unknown as InjectOptions);
    expect(response.statusCode).toBe(207);
    expect(response.body).toContain(`<D:quota-used-bytes>${String(used)}</D:quota-used-bytes>`);
    if (available === null) expect(response.body).not.toContain("<D:quota-available-bytes>");
    else
      expect(response.body).toContain(
        `<D:quota-available-bytes>${String(available)}</D:quota-available-bytes>`,
      );
    await app.close();
  });

  it("walks every cursor page for collections larger than 250 entries", async () => {
    const store = new FakeWebDavDriveStore();
    for (let index = 0; index < 300; index += 1) {
      const name = `page-${String(index).padStart(3, "0")}.txt`;
      store.files.set(name, fileEntry({ id: randomUUID(), name, content: name }));
    }
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
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
    expect(response.body).toContain("page-299.txt");
    expect(response.body.match(/<D:response>/gu)).toHaveLength(304);
  });

  it("pages collection-bound sync REPORT changes and rejects stale or foreign tokens", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });
    const report = (url: string, token = "", limit = 100) =>
      app.inject({
        method: "REPORT",
        url,
        headers: {
          authorization: basic("ada@example.test", "read"),
          "content-type": "application/xml",
        },
        payload: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:limit><D:nresults>${String(limit)}</D:nresults></D:limit></D:sync-collection>`,
      } as unknown as InjectOptions);

    const initial = await report("/dav/files/");
    const initialToken = /<D:sync-token>([^<]+)<\/D:sync-token>/u.exec(initial.body)?.[1] ?? "";
    store.changes.push(
      { pathKey: "/alpha.txt", resourceType: "file", status: 200, version: "1" },
      { pathKey: "/folder", resourceType: "folder", status: 200, version: "2" },
      { pathKey: "/gone.txt", resourceType: "file", status: 404, version: "3" },
    );
    const firstPage = await report("/dav/files/", initialToken, 2);
    const nextToken = /<D:sync-token>([^<]+)<\/D:sync-token>/u.exec(firstPage.body)?.[1] ?? "";
    const secondPage = await report("/dav/files/", nextToken, 2);
    const foreign = await report("/dav/files/Projects/", initialToken);
    store.syncMinimum = "2";
    const stale = await report("/dav/files/", initialToken);

    expect(initial.statusCode).toBe(207);
    expect(initial.body).toContain("/dav/files/report.txt");
    expect(initialToken).toMatch(/^urn:helix:webdav-sync:[0-9a-f]{24}:0$/u);
    expect(firstPage.statusCode).toBe(207);
    expect(firstPage.body).toContain("/dav/files/alpha.txt");
    expect(firstPage.body).toContain("/dav/files/folder/");
    expect(firstPage.body).not.toContain("gone.txt");
    expect(firstPage.body).toContain("number-of-matches-within-limits");
    expect(nextToken).toMatch(/:2$/u);
    expect(secondPage.body).toContain("/dav/files/gone.txt");
    expect(secondPage.body).toContain("HTTP/1.1 404 Not Found");
    expect(foreign.statusCode).toBe(409);
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain("valid-sync-token");
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
      payload: '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:made-up/></D:prop></D:propfind>',
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

    expect(blockedPut.statusCode).toBe(403);
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
    expect(blockedDelete.statusCode).toBe(403);
    expect(blockedDelete.body).toContain('"drive.delete" scope');
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
    expect(propfind.body).toContain("<D:href>/v1/dav/files/Projects/</D:href>");
    expect(propfind.body).toContain("<D:href>/v1/dav/files/Projects/roadmap.md</D:href>");
    expect(propfind.body).not.toContain("<D:href>/v1/dav/files/roadmap.md</D:href>");
    expect(createdNestedFolder.statusCode).toBe(201);
    expect(createdNestedFolder.headers.location).toBe("/v1/dav/files/Projects/Plans/");
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
    expect(store.uploads).toHaveLength(0);
    expect(store.finalized.at(-1)).toMatchObject({
      objectId: reportId,
      byteSize: 11,
      sha256: createHash("sha256").update("replacement").digest("hex"),
    });
  });

  it("keeps the prior file visible when an overwrite is interrupted", async () => {
    const store = new FakeWebDavDriveStore();
    store.failFinalize = true;
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const failed = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
      },
      payload: "replacement",
    });
    const original = await app.inject({
      method: "GET",
      url: "/dav/files/report.txt",
      headers: { authorization: basic("ada@example.test", "read") },
    });

    expect(failed.statusCode).toBe(500);
    expect(original.statusCode).toBe(200);
    expect(original.body).toBe("quarterly report");
    expect(store.trashed).toEqual([]);
  });

  it("supports exclusive WebDAV LOCK and UNLOCK tokens for mutations", async () => {
    const store = new FakeWebDavDriveStore();
    const app = fastify();
    await registerDriveRoutes(app, {
      store,
      appPasswords: new FakeAppPasswordAuthenticator(),
    });
    const replica = fastify();
    await registerDriveRoutes(replica, {
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
    const blockedPut = await replica.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        "content-type": "text/plain",
      },
      payload: "blocked",
    });
    const substringTokenPut = await app.inject({
      method: "PUT",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "write"),
        if: `(<${lockToken.replace(/^<|>$/gu, "")}-suffix>)`,
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
    expect(substringTokenPut.statusCode).toBe(423);
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

    const staleDelete = await app.inject({
      method: "DELETE",
      url: "/dav/files/report.txt",
      headers: {
        authorization: basic("ada@example.test", "delete"),
        "if-match": '"stale"',
      },
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

    expect(staleDelete.statusCode).toBe(412);
    expect(store.trashed).not.toContain(reportId);
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
        openFileByShareToken: async (input) => {
          if (input.token !== "goodtoken") {
            return null;
          }
          const content = Buffer.from("public bytes");
          return {
            entry: fileEntry({
              id: reportId,
              name: "shared-report.txt",
              content: "public bytes",
            }),
            byteSize: content.byteLength,
            etag: '"shared-report"',
            open: async (range) =>
              range === undefined ? content : content.subarray(range.start, range.end + 1),
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
    expect(response.headers["content-disposition"] ?? "").toContain("shared-report.txt");
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
  });

  it("supports Range requests on share-link content", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        openFileByShareToken: async () => {
          const content = Buffer.from("public bytes");
          return {
            entry: fileEntry({
              id: reportId,
              name: "shared-report.txt",
              content: "public bytes",
            }),
            byteSize: content.byteLength,
            etag: '"shared-report"',
            open: async (range) =>
              range === undefined ? content : content.subarray(range.start, range.end + 1),
          };
        },
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

  it("forces shared active HTML to download as inert bytes", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        openFileByShareToken: async () => {
          const content = Buffer.from("<script>fetch('/api/admin')</script>");
          return {
            entry: fileEntry({
              id: reportId,
              name: "attack.html",
              content: "<script>fetch('/api/admin')</script>",
              mimeType: "text/html",
            }),
            byteSize: content.byteLength,
            etag: '"active-html"',
            open: async (range) =>
              range === undefined ? content : content.subarray(range.start, range.end + 1),
          };
        },
      },
    });

    const response = await app.inject("/api/drive/share/goodtoken");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toMatch(/^attachment;/u);
  });

  it("uses one credential challenge for unknown, revoked, expired, and protected tokens", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        openFileByShareToken: async () => null,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/missing-token",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Helix shared file");
    expect(response.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
  });

  it("accepts a password through the browser-native Basic challenge", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        openFileByShareToken: async (input) => {
          if (input.password !== "open sesame password") return null;
          const content = Buffer.from("protected");
          return {
            entry: fileEntry({ id: reportId, name: "protected.txt", content: "protected" }),
            byteSize: content.byteLength,
            etag: '"protected"',
            open: async () => content,
          };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/protected-token",
      headers: {
        authorization: `Basic ${Buffer.from("shared:open sesame password").toString("base64")}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("protected");
  });

  it("returns 404 when backing content bytes are unavailable", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        openFileByShareToken: async () => ({
          entry: fileEntry({
            id: reportId,
            name: "pending.bin",
            content: "",
            mimeType: "application/octet-stream",
          }),
          byteSize: 1,
          etag: '"missing"',
          open: async () => null,
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/pending-token",
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("");
  });
});

describe("Drive transport hardening", () => {
  it("rejects plaintext WebDAV before checking app-password credentials", async () => {
    const app = fastify();
    await registerDriveRoutesStrict(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/dav/files/report.txt",
      headers: { authorization: basic("ada@example.test", "read") },
    });

    expect(response.statusCode).toBe(426);
    expect(response.headers.upgrade).toBe("TLS/1.2");
  });
  it("rate-limits WebDAV authentication before password verification", async () => {
    const app = fastify();
    const deny = () => ({ allowed: false, retryAfterSeconds: 30 });
    await registerDriveRoutes(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
      rateLimiter: { consume: deny, peek: deny },
    });

    const response = await app.inject({
      method: "GET",
      url: "/dav/files/report.txt",
      headers: { authorization: basic("ada@example.test", "wrong") },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
  });
  it("forces same-origin active content to an opaque attachment", async () => {
    const app = withApiErrorHandler(fastify());
    await registerDriveShareLinkRoute(app, {
      store: {
        openFileByShareToken: async () => ({
          entry: fileEntry({
            id: reportId,
            name: "payload.svg",
            content: "<svg><script>alert(1)</script></svg>",
            mimeType: "image/svg+xml",
          }),
          byteSize: Buffer.byteLength("<svg><script>alert(1)</script></svg>"),
          etag: '"svg"',
          open: async () => Buffer.from("<svg><script>alert(1)</script></svg>"),
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/drive/share/goodtoken",
    });

    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
  });
  it("rejects a forged forwarded protocol on an untrusted HTTP connection", async () => {
    const app = fastify();
    await registerDriveRoutesStrict(app, {
      store: new FakeWebDavDriveStore(),
      appPasswords: new FakeAppPasswordAuthenticator(),
    });
    const response = await app.inject({
      method: "GET",
      url: "/dav/files/report.txt",
      headers: { "x-forwarded-proto": "https", authorization: basic("ada@example.test", "read") },
    });
    expect(response.statusCode).toBe(426);
    await app.close();
  });
});
