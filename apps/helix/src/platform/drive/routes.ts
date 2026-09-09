// ponytail: WebDAV bodies stay plain-text per RFC 4918; not the JSON error envelope. File still >400 LOC with PROPFIND XML.
import { createHash, createHmac } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, NotFoundError, UnauthorizedError } from "../../api/api-error.js";
import { versionedApiPath } from "../../api/version.js";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import {
  DavStandardsParseError,
  davElements,
  davText,
  decodePathSegment,
  parseDavXml,
} from "../dav/standards.js";
import type {
  DriveFileReadInput,
  DriveFileReadResult,
  DriveFolderCreateInput,
  DriveStore,
} from "./store.js";
import type {
  AcquireDriveWebDavLockInput,
  DriveEntryRecord,
  DriveWebDavChangePage,
  DriveWebDavLock,
} from "./types.js";
import { safeDriveContentHeaders } from "./preview-security.js";
import { sendBytesWithRangeSupport, sendStreamWithRangeSupport } from "./range-response.js";
import { dlpDecisionError, type DlpGuard } from "../dlp.js";

export interface WebDavDriveStore extends DriveStore {
  createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord>;
  readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null>;
  trashFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null>;
  acquireWebDavLock(input: AcquireDriveWebDavLockInput): Promise<DriveWebDavLock | null>;
  listWebDavLocks(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly pathKeys: readonly string[];
  }): Promise<readonly DriveWebDavLock[]>;
  releaseWebDavLock(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly pathKey: string;
    readonly token: string;
  }): Promise<boolean>;
  listWebDavChanges(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly collectionPathKey: string;
    readonly afterVersion?: string;
    readonly limit: number;
  }): Promise<DriveWebDavChangePage>;
}

export interface RegisterDriveRoutesOptions {
  readonly store: WebDavDriveStore;
  readonly appPasswords: AppPasswordAuthenticator;
  /** WebDAV PUT is the bounded compatibility path; large browser uploads use
   * direct-to-storage multipart URLs and never cross the API body parser. */
  readonly bodyLimitBytes?: number;
  readonly dlp?: DlpGuard;
}

export interface RegisterDriveShareLinkRouteOptions {
  readonly store: Pick<DriveStore, "openFileByShareToken">;
  readonly actorFromRequest?: ((request: FastifyRequest) => Promise<Actor>) | undefined;
  readonly dlp?: DlpGuard;
}

type WebDavMethod = "PROPFIND" | "REPORT" | "GET" | "PUT" | "DELETE" | "MKCOL" | "LOCK" | "UNLOCK";

/**
 * Unauthenticated public share-link resolver. The token is the credential;
 * no session is required unless the owner restricts the link to verified
 * tenant domains. Streams bytes with Range support and fails closed when the
 * backing object cannot be integrity-checked.
 */
export async function registerDriveShareLinkRoute(
  app: FastifyInstance,
  options: RegisterDriveShareLinkRouteOptions,
): Promise<void> {
  app.get<{ Params: { token: string } }>("/api/drive/share/:token", async (request, reply) => {
    const token = request.params.token.trim();
    reply
      .header("cache-control", "private, no-store, max-age=0")
      .header("pragma", "no-cache")
      .header("x-content-type-options", "nosniff");
    if (token.length === 0) {
      throw new NotFoundError("Share link not found.");
    }
    if (options.store.openFileByShareToken === undefined) {
      // No dedicated not_implemented code in the envelope taxonomy; 500 is honest.
      throw new ApiError("internal_error", "Share links are not configured.");
    }
    const download = (request.query as { download?: string }).download === "1";
    const actor = await options.actorFromRequest?.(request);
    const password = sharePasswordFromRequest(request);
    const streamed = await options.store.openFileByShareToken({
      token,
      clientKey: createHmac("sha256", token)
        .update(request.ip || "unknown")
        .digest("hex"),
      ...(password === undefined ? {} : { password }),
      ...(actor === undefined ? {} : { actor }),
      download,
    });
    if (streamed === null) {
      reply.header("www-authenticate", 'Basic realm="Helix shared file", charset="UTF-8"');
      throw new UnauthorizedError("Share link is unavailable or requires credentials.");
    }
    if (options.dlp !== undefined && streamed.orgId !== undefined) {
      await enforceDriveDlp(options.dlp, reply, {
        orgId: streamed.orgId,
        actorId: actor?.id ?? "anonymous",
        boundary: "external_guest",
        resourceId: streamed.entry.id,
        traceId: request.id,
      });
    }
    const responseHeaders = safeDriveContentHeaders(
      streamed.entry.name,
      streamed.entry.mimeType ?? "application/octet-stream",
      !download,
    );
    return sendStreamWithRangeSupport({
      reply,
      request,
      byteSize: streamed.byteSize,
      etag: streamed.etag,
      open: streamed.open,
      ...responseHeaders,
      lastModified: streamed.entry.updatedAt,
    });
  });
}

function sharePasswordFromRequest(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  try {
    const basic = authorization.startsWith("Basic ");
    const encoded = basic
      ? authorization.slice("Basic ".length)
      : authorization.startsWith("SharePassword ")
        ? authorization.slice("SharePassword ".length)
        : null;
    if (encoded === null) return undefined;
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const separator = decoded.indexOf(":");
    if (basic && separator < 0) return undefined;
    const password = basic ? decoded.slice(separator + 1) : decoded;
    return password.length <= 256 ? password : undefined;
  } catch {
    return undefined;
  }
}

export async function registerDriveRoutes(
  app: FastifyInstance,
  options: RegisterDriveRoutesOptions,
): Promise<void> {
  safeAddHttpMethod(app, "PROPFIND", { hasBody: true });
  safeAddHttpMethod(app, "REPORT", { hasBody: true });
  safeAddHttpMethod(app, "MKCOL", { hasBody: true });
  safeAddHttpMethod(app, "LOCK", { hasBody: true });
  safeAddHttpMethod(app, "UNLOCK", { hasBody: false });
  safeAddContentTypeParser(app, "application/xml");
  safeAddContentTypeParser(app, "application/octet-stream");
  safeAddContentTypeParser(app, "text/xml");

  app.route({
    method: "OPTIONS",
    url: "/dav/files/*",
    handler: async (_request, reply) =>
      reply
        .header("DAV", "sync-collection")
        .header("Allow", "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, MKCOL, LOCK, UNLOCK")
        .code(204)
        .send(),
  });

  app.route({
    method: ["PROPFIND", "REPORT", "GET", "PUT", "DELETE", "MKCOL", "LOCK", "UNLOCK"],
    url: "/dav/files/*",
    bodyLimit: options.bodyLimitBytes ?? 128 * 1024 * 1024,
    handler: async (request, reply) => {
      const method = request.method as WebDavMethod;
      const actor = await authenticateWebDav(request, options.appPasswords, requiredScope(method));
      if (actor === null) {
        return reply
          .header("www-authenticate", 'Basic realm="Helix WebDAV"')
          .code(401)
          .send("WebDAV app password required.");
      }

      const path = parseDavFilePath(request.url);
      if (path === null) {
        return reply.code(400).send("Invalid WebDAV path.");
      }

      if (method === "PROPFIND") {
        const bodyText = bodyToString(request.body);
        try {
          if (bodyText.trim().length > 0) parseDavXml(bodyText);
        } catch (error) {
          if (error instanceof DavStandardsParseError) return reply.code(400).send(error.message);
          throw error;
        }
        const target = await resolveTarget(options.store, actor, path);
        if (target === null) {
          return reply.code(404).send("Unknown WebDAV resource.");
        }
        const depth = propfindDepth(headerString(request.headers.depth));
        const children =
          depth === 1 && target.kind === "folder"
            ? await listWebDavChildren(options.store, actor, target.folderId)
            : [];
        const requestedPathKeys = [
          pathKey(target.path),
          ...children.map((child) => pathKey([...target.path, child.name])),
        ];
        const locks = locksByRequestedPath(
          requestedPathKeys,
          await options.store.listWebDavLocks({
            orgId: actor.orgId,
            actorId: actor.id,
            pathKeys: requestedPathKeys,
          }),
        );
        const sync =
          target.kind === "folder"
            ? await options.store.listWebDavChanges({
                orgId: actor.orgId,
                actorId: actor.id,
                collectionPathKey: pathKey(target.path),
                limit: 1,
              })
            : undefined;
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(
            propfindMultistatusXml(
              target,
              children,
              bodyText,
              locks,
              sync === undefined
                ? undefined
                : webDavSyncToken(actor.orgId, pathKey(path), sync.version),
            ),
          );
      }

      if (method === "REPORT") {
        const bodyText = bodyToString(request.body);
        try {
          parseDavXml(bodyText);
        } catch (error) {
          if (error instanceof DavStandardsParseError) return reply.code(400).send(error.message);
          throw error;
        }
        const target = await resolveTarget(options.store, actor, path);
        if (target?.kind !== "folder") {
          return reply.code(404).send("Unknown WebDAV collection.");
        }
        const collectionPathKey = pathKey(path);
        const report = syncCollectionRequest(bodyText, actor.orgId, collectionPathKey);
        if (report === null) {
          return reply.code(400).send("Invalid sync-collection REPORT.");
        }
        if ("invalidToken" in report) {
          return reply
            .code(409)
            .type("application/xml; charset=utf-8")
            .send(xmlDocument('<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>'));
        }
        const page = await options.store.listWebDavChanges({
          orgId: actor.orgId,
          actorId: actor.id,
          collectionPathKey,
          ...(report.afterVersion === undefined ? {} : { afterVersion: report.afterVersion }),
          limit: report.limit,
        });
        if (!page.valid) {
          return reply
            .code(409)
            .type("application/xml; charset=utf-8")
            .send(xmlDocument('<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>'));
        }
        const changes =
          report.afterVersion === undefined
            ? (await listWebDavChildren(options.store, actor, target.folderId)).map((entry) => ({
                pathKey: pathKey([...path, entry.name]),
                status: 200 as const,
                resourceType: entry.type,
              }))
            : page.changes;
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(
            syncMultistatusXml(
              changes,
              webDavSyncToken(actor.orgId, collectionPathKey, page.version),
              page.hasMore,
              folderHref(path),
            ),
          );
      }

      if (method === "GET") {
        const target = await resolveTarget(options.store, actor, path);
        if (target === null || target.kind !== "file" || target.entry === undefined) {
          return reply.code(404).send("Unknown WebDAV file.");
        }
        const streamed = await options.store.openFile?.({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: target.entry.id,
        });
        if (streamed !== undefined && streamed !== null) {
          await enforceDriveDlp(options.dlp, reply, {
            orgId: actor.orgId,
            actorId: actor.id,
            boundary: "drive_download",
            resourceId: target.entry.id,
            traceId: request.id,
          });
          const responseHeaders = safeDriveContentHeaders(
            streamed.entry.name,
            streamed.entry.mimeType ?? "application/octet-stream",
            true,
          );
          return sendStreamWithRangeSupport({
            reply,
            request,
            byteSize: streamed.byteSize,
            etag: streamed.etag,
            open: streamed.open,
            ...responseHeaders,
            lastModified: streamed.entry.updatedAt,
          });
        }
        const file = await options.store.readFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: target.entry.id,
        });
        if (file?.content === null || file === null) {
          return reply.code(404).send("WebDAV file content is not available.");
        }
        await enforceDriveDlp(options.dlp, reply, {
          orgId: actor.orgId,
          actorId: actor.id,
          boundary: "drive_download",
          resourceId: target.entry.id,
          content: file.content,
          traceId: request.id,
        });
        reply.header("ETag", entryEtag(file.entry));
        const responseHeaders = safeDriveContentHeaders(
          file.entry.name,
          file.entry.mimeType ?? "application/octet-stream",
          true,
        );
        return sendBytesWithRangeSupport({
          reply,
          request,
          bytes: Buffer.from(file.content),
          ...responseHeaders,
          lastModified: file.entry.updatedAt,
        });
      }

      if (method === "DELETE") {
        const locked = await lockedPreconditionFailure(request, options.store, actor, path);
        if (locked !== null) {
          return reply.code(423).send(locked);
        }
        if (path.length === 0) {
          return reply.code(405).send("Cannot delete the root WebDAV collection.");
        }
        const target = await resolveTarget(options.store, actor, path);
        if (target === null || target.entry === undefined) {
          return reply.code(404).send("Unknown WebDAV resource.");
        }
        const preconditionFailure = putPreconditionFailure(request, target.entry);
        if (preconditionFailure !== null) {
          return reply.code(412).send(preconditionFailure);
        }
        if (target.kind === "folder") {
          const trashedFolder = await options.store.trashFolder({
            orgId: actor.orgId,
            actorId: actor.id,
            folderId: target.entry.id,
          });
          return trashedFolder === null
            ? reply.code(404).send("Unknown WebDAV collection.")
            : reply.code(204).send();
        }
        const trashed = await options.store.trash({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: target.entry.id,
        });
        return trashed === null
          ? reply.code(404).send("Unknown WebDAV file.")
          : reply.code(204).send();
      }

      if (method === "MKCOL") {
        const locked = await lockedPreconditionFailure(request, options.store, actor, path);
        if (locked !== null) {
          return reply.code(423).send(locked);
        }
        const parent = await resolveParentFolder(options.store, actor, path);
        if (parent === null) {
          return reply.code(409).send("Unknown WebDAV parent collection.");
        }
        const name = path.at(-1);
        if (name === undefined || name.length === 0) {
          return reply.code(405).send("Cannot create the root WebDAV collection.");
        }
        const existing = await findChild(options.store, actor, parent.folderId, name);
        if (existing !== null) {
          const preconditionFailure = putPreconditionFailure(request, existing);
          if (preconditionFailure !== null) return reply.code(412).send(preconditionFailure);
          return reply.code(405).send("WebDAV collection already exists.");
        }
        await options.store.createFolder({
          orgId: actor.orgId,
          actorId: actor.id,
          name,
          parentFolderId: parent.folderId,
        });
        return reply.header("Location", folderHref(path)).code(201).send();
      }

      if (method === "LOCK") {
        const bodyText = bodyToString(request.body);
        try {
          if (bodyText.trim().length > 0) parseDavXml(bodyText);
        } catch (error) {
          if (error instanceof DavStandardsParseError) return reply.code(400).send(error.message);
          throw error;
        }
        const target = await resolveTarget(options.store, actor, path);
        const parent =
          target === null ? await resolveParentFolder(options.store, actor, path) : null;
        if (target === null && parent === null) {
          return reply.code(409).send("Unknown WebDAV parent collection.");
        }
        const refreshToken = lockTokenFromRequest(request);
        const lock = await options.store.acquireWebDavLock({
          orgId: actor.orgId,
          actorId: actor.id,
          pathKey: pathKey(path),
          owner: lockOwner(bodyText),
          depth: lockDepth(headerString(request.headers.depth)),
          timeoutSeconds: lockTimeoutSeconds(headerString(request.headers.timeout)),
          ...(refreshToken === null ? {} : { token: refreshToken }),
        });
        if (lock === null) return reply.code(423).send("WebDAV resource is locked.");
        const href =
          target?.kind === "folder" || request.url.endsWith("/")
            ? folderHref(path)
            : fileHref(path);
        return reply
          .header("Lock-Token", `<${lock.token}>`)
          .code(target === null ? 201 : 200)
          .type("application/xml; charset=utf-8")
          .send(lockDiscoveryDocument(lock, href));
      }

      if (method === "UNLOCK") {
        const token = parseLockTokenHeader(headerString(request.headers["lock-token"]));
        if (token === null) {
          return reply.code(400).send("UNLOCK requires a Lock-Token header.");
        }
        const released = await options.store.releaseWebDavLock({
          orgId: actor.orgId,
          actorId: actor.id,
          pathKey: pathKey(path),
          token,
        });
        if (!released) {
          return reply.code(409).send("Unknown WebDAV lock token.");
        }
        return reply.code(204).send();
      }

      const parent = await resolveParentFolder(options.store, actor, path);
      if (parent === null) {
        return reply.code(409).send("Unknown WebDAV parent collection.");
      }
      const name = path.at(-1);
      if (name === undefined || name.length === 0) {
        return reply.code(409).send("PUT requires a file name.");
      }
      const existing = await findChild(options.store, actor, parent.folderId, name);
      if (existing?.type === "folder") {
        return reply.code(409).send("Cannot overwrite a WebDAV collection with a file.");
      }
      const locked = await lockedPreconditionFailure(request, options.store, actor, path);
      if (locked !== null) {
        return reply.code(423).send(locked);
      }
      const preconditionFailure = putPreconditionFailure(request, existing);
      if (preconditionFailure !== null) {
        return reply.code(412).send(preconditionFailure);
      }
      const body = bodyToBuffer(request.body);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const mimeType = headerString(request.headers["content-type"]) ?? "application/octet-stream";
      const objectId =
        existing?.id ??
        (
          await options.store.prepareUpload({
            orgId: actor.orgId,
            actorId: actor.id,
            name,
            folderId: parent.folderId,
            mimeType,
            byteSize: body.byteLength,
            sha256,
            metadata: { source: "webdav" },
          })
        ).objectId;
      const version = await options.store.finalizeUpload({
        orgId: actor.orgId,
        actorId: actor.id,
        objectId,
        byteSize: body.byteLength,
        sha256,
        mimeType,
        content: body,
        metadata: { source: "webdav" },
      });
      return reply
        .header("ETag", `"${objectId}-${String(version.versionNumber)}-${sha256}"`)
        .code(existing === null ? 201 : 204)
        .send();
    },
  });
}

async function enforceDriveDlp(
  guard: DlpGuard | undefined,
  reply: { header(name: string, value: string): unknown },
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly boundary: "drive_download" | "external_guest";
    readonly resourceId?: string;
    readonly content?: unknown;
    readonly traceId?: string;
  },
): Promise<void> {
  if (guard === undefined) return;
  const decision = await guard.evaluate({
    orgId: input.orgId,
    actorId: input.actorId,
    boundary: input.boundary,
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.resourceId === undefined
      ? {}
      : { resources: [{ resourceType: "drive.file", resourceId: input.resourceId }] }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
  if (decision.action === "block" || decision.action === "quarantine") {
    throw dlpDecisionError(decision);
  }
  if (decision.action === "warn") reply.header("x-helix-dlp-warning", decision.classification);
}

async function authenticateWebDav(
  request: FastifyRequest,
  authenticator: AppPasswordAuthenticator,
  requiredScope: string,
): Promise<Actor | null> {
  const credentials = parseBasicAuthorization(request.headers.authorization);
  if (credentials === null) {
    return null;
  }
  return authenticator.authenticateAppPassword({
    username: credentials.username,
    password: credentials.password,
    requiredScope,
    compatibilityScope: "webdav",
  });
}

function requiredScope(method: WebDavMethod): "drive.read" | "drive.write" | "drive.delete" {
  if (method === "DELETE") {
    return "drive.delete";
  }
  return method === "PUT" || method === "MKCOL" || method === "LOCK" || method === "UNLOCK"
    ? "drive.write"
    : "drive.read";
}

interface ResolvedTarget {
  readonly kind: "folder" | "file";
  readonly folderId: string | null;
  readonly entry?: DriveEntryRecord;
  readonly path: readonly string[];
}

async function resolveTarget(
  store: WebDavDriveStore,
  actor: Actor,
  path: readonly string[],
): Promise<ResolvedTarget | null> {
  if (path.length === 0) {
    return { kind: "folder", folderId: null, path };
  }
  const parent = await resolveParentFolder(store, actor, path);
  if (parent === null) {
    return null;
  }
  const name = path.at(-1);
  if (name === undefined) {
    return parent;
  }
  const child = await findChild(store, actor, parent.folderId, name);
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

async function resolveParentFolder(
  store: WebDavDriveStore,
  actor: Actor,
  path: readonly string[],
): Promise<ResolvedTarget | null> {
  let folderId: string | null = null;
  const parentSegments = path.slice(0, -1);
  for (const segment of parentSegments) {
    const child = await findChild(store, actor, folderId, segment);
    if (child === null || child.type !== "folder") {
      return null;
    }
    folderId = child.id;
  }
  return { kind: "folder", folderId, path: parentSegments };
}

async function findChild(
  store: WebDavDriveStore,
  actor: Actor,
  folderId: string | null,
  name: string,
): Promise<DriveEntryRecord | null> {
  let cursor: string | undefined;
  do {
    const page = await store.list({
      orgId: actor.orgId,
      actorId: actor.id,
      folderId,
      limit: 250,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const found = page.entries.find((entry) => entry.name === name);
    if (found !== undefined) return found;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return null;
}

async function listWebDavChildren(
  store: WebDavDriveStore,
  actor: Actor,
  folderId: string | null,
): Promise<readonly DriveEntryRecord[]> {
  const entries: DriveEntryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({
      orgId: actor.orgId,
      actorId: actor.id,
      folderId,
      limit: 250,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return entries;
}

function propfindMultistatusXml(
  target: ResolvedTarget,
  children: readonly DriveEntryRecord[],
  body: string,
  locks: ReadonlyMap<string, WebDavLock>,
  syncToken?: string,
) {
  const request = propfindRequest(body);
  const entries = [
    targetResponseXml(target, request, locks, syncToken),
    ...children.map((child) => childResponseXml(target.path, child, request, locks)),
  ];
  return xmlDocument(`<D:multistatus xmlns:D="DAV:">${entries.join("")}</D:multistatus>`);
}

function targetResponseXml(
  target: ResolvedTarget,
  request: PropfindRequest,
  locks: ReadonlyMap<string, WebDavLock>,
  syncToken?: string,
): string {
  const href = target.kind === "folder" ? folderHref(target.path) : fileHref(target.path);
  const entry = target.entry;
  return responseXml({
    request,
    href,
    isCollection: target.kind === "folder",
    name: entry?.name ?? "files",
    updatedAt: entry?.updatedAt,
    createdAt: entry?.createdAt,
    contentLength: entry?.byteSize,
    contentType: entry?.mimeType,
    etag: entry === undefined ? undefined : entryEtag(entry),
    lock: locks.get(pathKey(target.path)),
    syncToken,
  });
}

function childResponseXml(
  parentPath: readonly string[],
  entry: DriveEntryRecord,
  request: PropfindRequest,
  locks: ReadonlyMap<string, WebDavLock>,
): string {
  const path = [...parentPath, entry.name];
  return responseXml({
    request,
    href: entry.type === "folder" ? folderHref(path) : fileHref(path),
    isCollection: entry.type === "folder",
    name: entry.name,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    contentLength: entry.byteSize,
    contentType: entry.mimeType,
    etag: entryEtag(entry),
    lock: locks.get(pathKey(path)),
  });
}

type WebDavProperty =
  | "creationdate"
  | "displayname"
  | "getcontentlength"
  | "getcontenttype"
  | "getetag"
  | "getlastmodified"
  | "lockdiscovery"
  | "quota-available-bytes"
  | "quota-used-bytes"
  | "resourcetype"
  | "sync-token"
  | "supported-report-set"
  | "supportedlock";

type PropfindRequest =
  | { readonly mode: "allprop" }
  | { readonly mode: "propname" }
  | { readonly mode: "prop"; readonly names: readonly string[] };

const supportedWebDavProperties = new Set<WebDavProperty>([
  "creationdate",
  "displayname",
  "getcontentlength",
  "getcontenttype",
  "getetag",
  "getlastmodified",
  "lockdiscovery",
  "quota-available-bytes",
  "quota-used-bytes",
  "resourcetype",
  "sync-token",
  "supported-report-set",
  "supportedlock",
]);

const webDavQuotaAvailableBytes = 10 * 1024 * 1024 * 1024 * 1024;

type WebDavLock = DriveWebDavLock;

function responseXml(input: {
  readonly request: PropfindRequest;
  readonly href: string;
  readonly isCollection: boolean;
  readonly name: string;
  readonly updatedAt?: Date | undefined;
  readonly createdAt?: Date | undefined;
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
  readonly etag?: string | undefined;
  readonly lock?: WebDavLock | undefined;
  readonly syncToken?: string | undefined;
}): string {
  const values: Partial<Record<WebDavProperty, string | undefined>> = {
    creationdate:
      input.createdAt === undefined
        ? undefined
        : `<D:creationdate>${input.createdAt.toISOString()}</D:creationdate>`,
    displayname: `<D:displayname>${xmlEscape(input.name)}</D:displayname>`,
    getcontentlength:
      input.contentLength === undefined
        ? undefined
        : `<D:getcontentlength>${String(input.contentLength)}</D:getcontentlength>`,
    getcontenttype:
      input.contentType === undefined
        ? undefined
        : `<D:getcontenttype>${xmlEscape(input.contentType)}</D:getcontenttype>`,
    getetag:
      input.etag === undefined ? undefined : `<D:getetag>${xmlEscape(input.etag)}</D:getetag>`,
    getlastmodified:
      input.updatedAt === undefined
        ? undefined
        : `<D:getlastmodified>${input.updatedAt.toUTCString()}</D:getlastmodified>`,
    lockdiscovery: lockDiscoveryProp(input.lock, input.href),
    "quota-available-bytes": `<D:quota-available-bytes>${String(webDavQuotaAvailableBytes)}</D:quota-available-bytes>`,
    "quota-used-bytes": `<D:quota-used-bytes>${String(input.contentLength ?? 0)}</D:quota-used-bytes>`,
    resourcetype: `<D:resourcetype>${input.isCollection ? "<D:collection/>" : ""}</D:resourcetype>`,
    "sync-token":
      input.syncToken === undefined
        ? undefined
        : `<D:sync-token>${xmlEscape(input.syncToken)}</D:sync-token>`,
    "supported-report-set": input.isCollection
      ? "<D:supported-report-set><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>"
      : undefined,
    supportedlock:
      "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>",
  };
  const requested = requestedProperties(input.request);
  const okProps =
    input.request.mode === "propname"
      ? [...supportedWebDavProperties].map((name) => `<D:${name}/>`)
      : requested
          .map((name) => values[name])
          .filter((value): value is string => value !== undefined);
  const notFound =
    input.request.mode === "propname"
      ? []
      : requested.filter((name) => values[name] === undefined).map((name) => `<D:${name}/>`);
  const unknown =
    input.request.mode === "prop"
      ? input.request.names.filter((name) => !isWebDavProperty(name)).map((name) => `<D:${name}/>`)
      : [];
  const okPropstat =
    okProps.length === 0
      ? ""
      : `<D:propstat><D:prop>${okProps.join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
  const missingProps = [...notFound, ...unknown];
  const missingPropstat =
    missingProps.length === 0
      ? ""
      : `<D:propstat><D:prop>${missingProps.join("")}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`;
  return `<D:response><D:href>${xmlEscape(input.href)}</D:href>${okPropstat}${missingPropstat}</D:response>`;
}

async function lockedPreconditionFailure(
  request: FastifyRequest,
  store: WebDavDriveStore,
  actor: Actor,
  path: readonly string[],
): Promise<string | null> {
  const lock = (
    await store.listWebDavLocks({
      orgId: actor.orgId,
      actorId: actor.id,
      pathKeys: [pathKey(path)],
    })
  )[0];
  if (
    lock === undefined ||
    (lock.actorId === actor.id && requestIncludesLockToken(request, lock.token))
  ) {
    return null;
  }
  return "WebDAV resource is locked.";
}

function locksByRequestedPath(
  pathKeys: readonly string[],
  locks: readonly WebDavLock[],
): ReadonlyMap<string, WebDavLock> {
  const mapped = new Map<string, WebDavLock>();
  for (const requested of pathKeys) {
    const lock = locks.find(
      (candidate) =>
        candidate.pathKey === requested ||
        (candidate.depth === "infinity" &&
          (candidate.pathKey === "/" || requested.startsWith(`${candidate.pathKey}/`))),
    );
    if (lock !== undefined) mapped.set(requested, lock);
  }
  return mapped;
}

function requestIncludesLockToken(request: FastifyRequest, token: string): boolean {
  const ifHeader = headerString(request.headers.if);
  const lockTokenHeader = parseLockTokenHeader(headerString(request.headers["lock-token"]));
  const ifTokens = [...(ifHeader ?? "").matchAll(/<(?<token>[^>]+)>/gu)].map(
    (match) => match.groups?.token,
  );
  return lockTokenHeader === token || ifTokens.includes(token);
}

function parseLockTokenHeader(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/^<|>$/gu, "");
}

function lockTokenFromRequest(request: FastifyRequest): string | null {
  const token = parseLockTokenHeader(headerString(request.headers["lock-token"]));
  if (token !== null) return token;
  return (
    /opaquelocktoken:[0-9a-f-]{36}/iu.exec(headerString(request.headers.if) ?? "")?.[0] ?? null
  );
}

function pathKey(path: readonly string[]): string {
  return `/${path.join("/")}`;
}

function lockDepth(value: string | undefined): "0" | "infinity" {
  return value?.trim() === "0" ? "0" : "infinity";
}

function lockTimeoutSeconds(value: string | undefined): number {
  const seconds = /Second-(?<seconds>[0-9]+)/iu.exec(value ?? "")?.groups?.seconds;
  if (seconds === undefined) {
    return 600;
  }
  const parsed = Number.parseInt(seconds, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 600;
  }
  return Math.min(parsed, 3600);
}

function lockOwner(body: string): string {
  if (body.trim().length === 0) return "";
  return davText(davElements(parseDavXml(body), "owner")[0])
    .trim()
    .slice(0, 1_024);
}

function lockDiscoveryDocument(lock: WebDavLock, href: string): string {
  return xmlDocument(`<D:prop xmlns:D="DAV:">${lockDiscoveryProp(lock, href)}</D:prop>`);
}

function lockDiscoveryProp(lock: WebDavLock | undefined, href: string): string {
  if (lock === undefined) {
    return "<D:lockdiscovery/>";
  }
  return `<D:lockdiscovery>${activeLockXml(lock, href)}</D:lockdiscovery>`;
}

function activeLockXml(lock: WebDavLock, href: string): string {
  const timeoutSeconds = Math.max(1, Math.ceil((lock.expiresAt.getTime() - Date.now()) / 1000));
  return [
    "<D:activelock>",
    "<D:locktype><D:write/></D:locktype>",
    "<D:lockscope><D:exclusive/></D:lockscope>",
    `<D:depth>${lock.depth === "0" ? "0" : "Infinity"}</D:depth>`,
    lock.owner.length === 0 ? "" : `<D:owner>${xmlEscape(lock.owner)}</D:owner>`,
    `<D:timeout>Second-${String(timeoutSeconds)}</D:timeout>`,
    `<D:locktoken><D:href>${xmlEscape(lock.token)}</D:href></D:locktoken>`,
    `<D:lockroot><D:href>${xmlEscape(href)}</D:href></D:lockroot>`,
    "</D:activelock>",
  ].join("");
}

function requestedProperties(request: PropfindRequest): readonly WebDavProperty[] {
  if (request.mode === "propname") {
    return [...supportedWebDavProperties];
  }
  if (request.mode === "allprop") {
    return [...supportedWebDavProperties];
  }
  return request.names.filter(isWebDavProperty);
}

function isWebDavProperty(name: string): name is WebDavProperty {
  return supportedWebDavProperties.has(name as WebDavProperty);
}

function propfindRequest(body: string): PropfindRequest {
  if (body.trim().length === 0) return { mode: "allprop" };
  const root = parseDavXml(body);
  if (davElements(root, "propname").length > 0) return { mode: "propname" };
  const prop = davElements(root, "prop")[0];
  if (prop === undefined) return { mode: "allprop" };
  const names = prop.children.map((child) => child.name);
  return names.length === 0 ? { mode: "allprop" } : { mode: "prop", names };
}

function syncCollectionRequest(
  body: string,
  orgId: string,
  collectionPathKey: string,
):
  | { readonly afterVersion?: string; readonly limit: number }
  | { readonly invalidToken: true }
  | null {
  const root = parseDavXml(body);
  if (davElements(root, "sync-collection").length === 0) return null;
  const syncLevel = davText(davElements(root, "sync-level")[0]);
  if (syncLevel.length > 0 && syncLevel.trim() !== "1") return null;
  const rawToken = davText(davElements(root, "sync-token")[0]).trim();
  const limitText = davText(davElements(root, "nresults")[0]).trim();
  const parsedLimit = limitText.length === 0 ? 100 : Number.parseInt(limitText, 10);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) return null;
  if (rawToken.length === 0) {
    return { limit: Math.min(parsedLimit, 250) };
  }
  const prefix = webDavSyncTokenPrefix(orgId, collectionPathKey);
  const match = new RegExp(`^${prefix}:(?<version>0|[1-9][0-9]{0,18})$`, "u").exec(rawToken);
  const afterVersion = match?.groups?.version;
  return afterVersion === undefined
    ? { invalidToken: true }
    : { afterVersion, limit: Math.min(parsedLimit, 250) };
}

function webDavSyncToken(orgId: string, collectionPathKey: string, version: string): string {
  return `${webDavSyncTokenPrefix(orgId, collectionPathKey)}:${version}`;
}

function webDavSyncTokenPrefix(orgId: string, collectionPathKey: string): string {
  const collection = createHash("sha256")
    .update(orgId)
    .update("\0")
    .update(collectionPathKey)
    .digest("hex")
    .slice(0, 24);
  return `urn:helix:webdav-sync:${collection}`;
}

function syncMultistatusXml(
  changes: readonly {
    readonly pathKey: string;
    readonly resourceType: "file" | "folder";
    readonly status: 200 | 404;
  }[],
  token: string,
  hasMore: boolean,
  collectionHref: string,
): string {
  const responses = changes.map((change) => {
    const href = hrefFromPathKey(change.pathKey, change.resourceType);
    return `<D:response><D:href>${xmlEscape(href)}</D:href><D:status>HTTP/1.1 ${String(change.status)} ${change.status === 200 ? "OK" : "Not Found"}</D:status></D:response>`;
  });
  if (hasMore) {
    responses.push(
      `<D:response><D:href>${xmlEscape(collectionHref)}</D:href><D:status>HTTP/1.1 507 Insufficient Storage</D:status><D:error><D:number-of-matches-within-limits/></D:error></D:response>`,
    );
  }
  return xmlDocument(
    `<D:multistatus xmlns:D="DAV:">${responses.join("")}<D:sync-token>${xmlEscape(token)}</D:sync-token></D:multistatus>`,
  );
}

function hrefFromPathKey(value: string, resourceType: "file" | "folder"): string {
  const path = value
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0);
  return resourceType === "folder" ? folderHref(path) : fileHref(path);
}

function parseDavFilePath(url: string): readonly string[] | null {
  const path = url.split("?")[0] ?? url;
  const marker = "/dav/files";
  if (!path.startsWith(marker)) {
    return null;
  }
  const suffix = path.slice(marker.length).replace(/^\/+|\/+$/gu, "");
  if (suffix.length === 0) {
    return [];
  }
  try {
    return suffix.split("/").map(decodePathSegment);
  } catch {
    return null;
  }
}

function folderHref(path: readonly string[]): string {
  return versionedApiPath(
    `/dav/files/${path.map(encodeURIComponent).join("/")}${path.length === 0 ? "" : "/"}`,
  );
}

function fileHref(path: readonly string[]): string {
  return versionedApiPath(`/dav/files/${path.map(encodeURIComponent).join("/")}`);
}

function entryEtag(entry: DriveEntryRecord): string {
  return `"${entry.id}-${String(entry.versionNumber ?? 0)}-${entry.sha256 ?? "folder"}"`;
}

function bodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  return Buffer.from(JSON.stringify(body));
}

function bodyToString(body: unknown): string {
  return bodyToBuffer(body).toString("utf8");
}

function parseBasicAuthorization(
  authorization: string | undefined,
): { readonly username: string; readonly password: string } | null {
  if (authorization === undefined) {
    return null;
  }
  const [scheme, value] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "basic" || value === undefined) {
    return null;
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function propfindDepth(value: string | undefined): 0 | 1 {
  return value?.trim() === "0" ? 0 : 1;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function putPreconditionFailure(
  request: FastifyRequest,
  existing: DriveEntryRecord | null,
): string | null {
  const ifNoneMatch = headerString(request.headers["if-none-match"]);
  if (ifNoneMatch?.trim() === "*" && existing !== null) {
    return "WebDAV resource already exists.";
  }
  const ifMatch = headerString(request.headers["if-match"]);
  if (ifMatch === undefined) {
    return null;
  }
  const candidates = ifMatch
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (existing === null) {
    return "WebDAV resource does not exist.";
  }
  if (candidates.includes("*") || candidates.includes(entryEtag(existing))) {
    return null;
  }
  return "WebDAV ETag precondition failed.";
}

function safeAddHttpMethod(
  app: FastifyInstance,
  method: string,
  options: { readonly hasBody: boolean },
): void {
  try {
    app.addHttpMethod(method, options);
  } catch {
    // Another DAV module may already have registered the extension method.
  }
}

function safeAddContentTypeParser(app: FastifyInstance, contentType: string): void {
  try {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  } catch {
    // Parser may already be registered by a sibling route module in tests.
  }
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>${body}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
