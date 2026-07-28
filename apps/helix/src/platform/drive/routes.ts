// ponytail: WebDAV bodies stay plain-text per RFC 4918; not the JSON error envelope. File still >400 LOC with PROPFIND XML.
import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, NotFoundError } from "../../api/api-error.js";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import type {
  DriveFileReadInput,
  DriveFileReadResult,
  DriveFolderCreateInput,
  DriveStore,
} from "./store.js";
import type { DriveEntryRecord } from "./types.js";
import { sendBytesWithRangeSupport } from "./range-response.js";

export interface WebDavDriveStore extends DriveStore {
  createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord>;
  readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null>;
  trashFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null>;
}

export interface RegisterDriveRoutesOptions {
  readonly store: WebDavDriveStore;
  readonly appPasswords: AppPasswordAuthenticator;
}

export interface RegisterDriveShareLinkRouteOptions {
  readonly store: Pick<DriveStore, "readFileByShareToken">;
}

type WebDavMethod = "PROPFIND" | "GET" | "PUT" | "DELETE" | "MKCOL" | "LOCK" | "UNLOCK";

/**
 * Unauthenticated public share-link resolver. The token is the credential;
 * no session cookie or scope is required. Streams bytes with Range support
 * when content is available; otherwise returns JSON metadata for the object.
 */
export async function registerDriveShareLinkRoute(
  app: FastifyInstance,
  options: RegisterDriveShareLinkRouteOptions,
): Promise<void> {
  app.get<{ Params: { token: string } }>("/api/drive/share/:token", async (request, reply) => {
    const token = request.params.token.trim();
    if (token.length === 0) {
      throw new NotFoundError("Share link not found.");
    }
    if (options.store.readFileByShareToken === undefined) {
      // No dedicated not_implemented code in the envelope taxonomy; 500 is honest.
      throw new ApiError("internal_error", "Share links are not configured.");
    }
    const file = await options.store.readFileByShareToken(token);
    if (file === null) {
      throw new NotFoundError("Share link not found.");
    }

    const filename = file.entry.name;
    const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, '\\"');
    const utf8Encoded = encodeURIComponent(filename);
    const download = (request.query as { download?: string }).download === "1";
    const disposition = `${download ? "attachment" : "inline"}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;

    if (file.content !== null) {
      return sendBytesWithRangeSupport({
        reply,
        request,
        bytes: Buffer.from(file.content),
        mimeType: file.entry.mimeType ?? "application/octet-stream",
        disposition,
      });
    }

    // Content unavailable (no blob yet / storage miss) — return metadata only.
    return reply.code(200).send({
      objectId: file.entry.id,
      name: file.entry.name,
      mimeType: file.entry.mimeType ?? "application/octet-stream",
      byteSize: file.entry.byteSize ?? 0,
      contentAvailable: false,
    });
  });
}

export async function registerDriveRoutes(
  app: FastifyInstance,
  options: RegisterDriveRoutesOptions,
): Promise<void> {
  safeAddHttpMethod(app, "PROPFIND", { hasBody: true });
  safeAddHttpMethod(app, "MKCOL", { hasBody: true });
  safeAddHttpMethod(app, "LOCK", { hasBody: true });
  safeAddHttpMethod(app, "UNLOCK", { hasBody: false });
  safeAddContentTypeParser(app, "application/xml");
  safeAddContentTypeParser(app, "application/octet-stream");
  safeAddContentTypeParser(app, "text/xml");

  const locks = new Map<string, WebDavLock>();

  app.route({
    method: "OPTIONS",
    url: "/dav/files/*",
    handler: async (_request, reply) =>
      reply
        .header("DAV", "1, 2")
        .header("Allow", "OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, LOCK, UNLOCK")
        .code(204)
        .send(),
  });

  app.route({
    method: ["PROPFIND", "GET", "PUT", "DELETE", "MKCOL", "LOCK", "UNLOCK"],
    url: "/dav/files/*",
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
        const target = await resolveTarget(options.store, actor, path);
        if (target === null) {
          return reply.code(404).send("Unknown WebDAV resource.");
        }
        const depth = propfindDepth(headerString(request.headers.depth));
        const children =
          depth === 1 && target.kind === "folder"
            ? await options.store.list({
                orgId: actor.orgId,
                actorId: actor.id,
                folderId: target.folderId,
                limit: 250,
              })
            : [];
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(propfindMultistatusXml(target, children, bodyToString(request.body), locks));
      }

      if (method === "GET") {
        const target = await resolveTarget(options.store, actor, path);
        if (target === null || target.kind !== "file" || target.entry === undefined) {
          return reply.code(404).send("Unknown WebDAV file.");
        }
        const file = await options.store.readFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: target.entry.id,
        });
        if (file?.content === null || file === null) {
          return reply.code(404).send("WebDAV file content is not available.");
        }
        reply.header("ETag", entryEtag(file.entry));
        const fileName = file.entry.name.replaceAll('"', "");
        return sendBytesWithRangeSupport({
          reply,
          request,
          bytes: Buffer.from(file.content),
          mimeType: file.entry.mimeType ?? "application/octet-stream",
          disposition: `inline; filename="${fileName}"`,
        });
      }

      if (method === "DELETE") {
        const locked = lockedPreconditionFailure(request, locks, path);
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
        const locked = lockedPreconditionFailure(request, locks, path);
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
        const target = await resolveTarget(options.store, actor, path);
        const parent =
          target === null ? await resolveParentFolder(options.store, actor, path) : null;
        if (target === null && parent === null) {
          return reply.code(409).send("Unknown WebDAV parent collection.");
        }
        const existingLock = findLockForPath(locks, path);
        if (existingLock !== undefined && !requestIncludesLockToken(request, existingLock.token)) {
          return reply.code(423).send("WebDAV resource is locked.");
        }
        const lock = existingLock ?? createWebDavLock(request, actor, path);
        locks.set(lock.pathKey, lock);
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
        const lock = locks.get(pathKey(path));
        if (lock === undefined || lock.token !== token) {
          return reply.code(409).send("Unknown WebDAV lock token.");
        }
        locks.delete(lock.pathKey);
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
      const locked = lockedPreconditionFailure(request, locks, path);
      if (locked !== null) {
        return reply.code(423).send(locked);
      }
      const preconditionFailure = putPreconditionFailure(request, existing);
      if (preconditionFailure !== null) {
        return reply.code(412).send(preconditionFailure);
      }
      if (existing?.type === "file") {
        await options.store.delete({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: existing.id,
        });
      }
      const body = bodyToBuffer(request.body);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const upload = await options.store.prepareUpload({
        orgId: actor.orgId,
        actorId: actor.id,
        name,
        folderId: parent.folderId,
        mimeType: headerString(request.headers["content-type"]) ?? "application/octet-stream",
        byteSize: body.byteLength,
        sha256,
        metadata: { source: "webdav" },
      });
      const version = await options.store.finalizeUpload({
        orgId: actor.orgId,
        actorId: actor.id,
        objectId: upload.objectId,
        byteSize: body.byteLength,
        sha256,
        mimeType: upload.mimeType,
        content: body,
        metadata: { source: "webdav" },
      });
      return reply
        .header("ETag", `"${upload.objectId}-${String(version.versionNumber)}-${sha256}"`)
        .code(existing === null ? 201 : 204)
        .send();
    },
  });
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
  const children = await store.list({
    orgId: actor.orgId,
    actorId: actor.id,
    folderId,
    limit: 250,
  });
  return children.find((entry) => entry.name === name) ?? null;
}

function propfindMultistatusXml(
  target: ResolvedTarget,
  children: readonly DriveEntryRecord[],
  body: string,
  locks: ReadonlyMap<string, WebDavLock>,
) {
  const request = propfindRequest(body);
  const entries = [
    targetResponseXml(target, request, locks),
    ...children.map((child) => childResponseXml(target.path, child, request, locks)),
  ];
  return xmlDocument(`<D:multistatus xmlns:D="DAV:">${entries.join("")}</D:multistatus>`);
}

function targetResponseXml(
  target: ResolvedTarget,
  request: PropfindRequest,
  locks: ReadonlyMap<string, WebDavLock>,
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
  "supportedlock",
]);

const webDavQuotaAvailableBytes = 10 * 1024 * 1024 * 1024 * 1024;

interface WebDavLock {
  readonly pathKey: string;
  readonly token: string;
  readonly owner: string | null;
  readonly actorId: string;
  readonly depth: "0" | "infinity";
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

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

function createWebDavLock(
  request: FastifyRequest,
  actor: Actor,
  path: readonly string[],
): WebDavLock {
  const timeoutSeconds = lockTimeoutSeconds(headerString(request.headers.timeout));
  const createdAt = new Date();
  return {
    pathKey: pathKey(path),
    token: `opaquelocktoken:${randomUUID()}`,
    owner: lockOwner(bodyToString(request.body)),
    actorId: actor.id,
    depth: lockDepth(headerString(request.headers.depth)),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + timeoutSeconds * 1000),
  };
}

function lockedPreconditionFailure(
  request: FastifyRequest,
  locks: Map<string, WebDavLock>,
  path: readonly string[],
): string | null {
  const lock = findLockForPath(locks, path);
  if (lock === undefined || requestIncludesLockToken(request, lock.token)) {
    return null;
  }
  return "WebDAV resource is locked.";
}

function findLockForPath(
  locks: Map<string, WebDavLock>,
  path: readonly string[],
): WebDavLock | undefined {
  cleanupExpiredLocks(locks);
  const direct = locks.get(pathKey(path));
  if (direct !== undefined) {
    return direct;
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const candidate = locks.get(pathKey(path.slice(0, index)));
    if (candidate?.depth === "infinity") {
      return candidate;
    }
  }
  return undefined;
}

function cleanupExpiredLocks(locks: Map<string, WebDavLock>): void {
  const nowMs = Date.now();
  for (const [key, lock] of locks.entries()) {
    if (lock.expiresAt.getTime() <= nowMs) {
      locks.delete(key);
    }
  }
}

function requestIncludesLockToken(request: FastifyRequest, token: string): boolean {
  const ifHeader = headerString(request.headers.if);
  const lockTokenHeader = parseLockTokenHeader(headerString(request.headers["lock-token"]));
  return (
    lockTokenHeader === token ||
    ifHeader?.includes(`<${token}>`) === true ||
    ifHeader?.includes(token) === true
  );
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

function lockOwner(body: string): string | null {
  const owner = /<[^>]*owner\b[^>]*>(?<owner>[\s\S]*?)<\/[^>]*owner>/iu.exec(body)?.groups?.owner;
  if (owner === undefined) {
    return null;
  }
  const text = owner.replaceAll(/<[^>]+>/gu, "").trim();
  return text.length === 0 ? null : text;
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
    lock.owner === null ? "" : `<D:owner>${xmlEscape(lock.owner)}</D:owner>`,
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
  if (/<[^>]*propname[\s/>]/iu.test(body)) {
    return { mode: "propname" };
  }
  const propMatch = /<[^>]*prop\b[^>]*>(?<body>[\s\S]*?)<\/[^>]*prop>/iu.exec(body);
  if (propMatch?.groups?.body === undefined) {
    return { mode: "allprop" };
  }
  const names = [
    ...propMatch.groups.body.matchAll(
      /<(?<name>[A-Za-z0-9_-]+:)?(?<local>[A-Za-z0-9_-]+)\b[^>]*\/?>/gu,
    ),
  ]
    .map((match) => match.groups?.local)
    .filter((name): name is string => name !== undefined)
    .filter((name) => name !== "prop");
  return names.length === 0 ? { mode: "allprop" } : { mode: "prop", names };
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
    return suffix.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function folderHref(path: readonly string[]): string {
  return `/dav/files/${path.map(encodeURIComponent).join("/")}${path.length === 0 ? "" : "/"}`;
}

function fileHref(path: readonly string[]): string {
  return `/dav/files/${path.map(encodeURIComponent).join("/")}`;
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
