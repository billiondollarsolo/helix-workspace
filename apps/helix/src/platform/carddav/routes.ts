import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import { InvalidVcardError, type CardDavContactRecord, type CardDavContactStore } from "./store.js";

export interface RegisterCardDavRoutesOptions {
  readonly appPasswords: AppPasswordAuthenticator;
  readonly store: CardDavContactStore;
}

type CardDavMethod = "PROPFIND" | "REPORT" | "GET" | "PUT" | "DELETE";

export async function registerCardDavRoutes(
  app: FastifyInstance,
  options: RegisterCardDavRoutesOptions,
): Promise<void> {
  safeAddHttpMethod(app, "PROPFIND", { hasBody: true });
  safeAddHttpMethod(app, "REPORT", { hasBody: true });
  safeAddContentTypeParser(app, "application/xml");
  safeAddContentTypeParser(app, "text/xml");
  safeAddContentTypeParser(app, "text/vcard");
  safeAddContentTypeParser(app, "text/x-vcard");

  app.route({
    method: "OPTIONS",
    url: "/dav/card/*",
    handler: async (_request, reply) =>
      reply
        .header("DAV", "1, addressbook")
        .header("Allow", "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE")
        .code(204)
        .send(),
  });

  app.route({
    method: ["PROPFIND", "REPORT", "GET", "PUT", "DELETE"],
    url: "/dav/card/*",
    handler: async (request, reply) => {
      const method = request.method as CardDavMethod;
      const actor = await authenticateCardDav(
        request,
        options.appPasswords,
        method === "PUT" || method === "DELETE" ? "carddav.write" : "carddav.read",
      );
      if (actor === null) {
        return reply
          .header("www-authenticate", 'Basic realm="Helix CardDAV"')
          .code(401)
          .send("CardDAV app password required.");
      }

      if (method === "GET") {
        if (isSelfVcardRequest(request.url, actor)) {
          return reply
            .header("ETag", selfCardEtag(actor))
            .type("text/vcard; charset=utf-8")
            .send(actorVcard(actor));
        }
        const href = contactHrefFromRequest(request.url, actor);
        if (href === null) {
          return reply.code(404).send("Unknown CardDAV resource.");
        }
        const contact = await options.store.getContactForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          href,
        });
        if (contact === null) {
          return reply.code(404).send("Unknown CardDAV contact.");
        }
        return reply
          .header("ETag", contact.etag)
          .type("text/vcard; charset=utf-8")
          .send(contact.vcard);
      }

      if (method === "PUT") {
        const writeTarget = await resolveCardDavWriteTarget(request, actor, options.store);
        if (!writeTarget.ok) {
          return reply.code(writeTarget.status).send(writeTarget.message);
        }
        try {
          const result = await options.store.upsertContactFromVcard({
            orgId: actor.orgId,
            actorId: actor.id,
            href: writeTarget.href,
            vcard: bodyToString(request.body),
          });
          return await reply
            .header("ETag", result.contact.etag)
            .header("Location", contactHref(actor, result.contact))
            .code(result.created ? 201 : 204)
            .send();
        } catch (error) {
          if (error instanceof InvalidVcardError) {
            return await reply.code(400).send(error.message);
          }
          throw error;
        }
      }

      if (method === "DELETE") {
        const writeTarget = await resolveCardDavWriteTarget(request, actor, options.store);
        if (!writeTarget.ok) {
          return reply.code(writeTarget.status).send(writeTarget.message);
        }
        const deleted = await options.store.deleteContact({
          orgId: actor.orgId,
          actorId: actor.id,
          href: writeTarget.href,
        });
        return deleted ? reply.code(204).send() : reply.code(404).send("Unknown CardDAV contact.");
      }

      const contacts = await options.store.listContactsForActor({
        orgId: actor.orgId,
        actorId: actor.id,
      });
      const syncVersion = await options.store.getContactSyncVersionForActor({
        orgId: actor.orgId,
        actorId: actor.id,
      });
      if (method === "REPORT") {
        const bodyText = bodyToString(request.body);
        if (isSyncCollectionReport(bodyText)) {
          const sinceSyncVersion = syncCollectionVersion(bodyText);
          const changes =
            sinceSyncVersion === undefined
              ? contacts
              : await options.store.listContactChangesForActor({
                  orgId: actor.orgId,
                  actorId: actor.id,
                  sinceSyncVersion,
                });
          return reply
            .code(207)
            .type("application/xml; charset=utf-8")
            .send(
              cardDavSyncCollectionXml(actor, contacts, changes, syncVersion, sinceSyncVersion),
            );
        }
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(cardDavReportXml(actor, contacts, bodyText));
      }

      const target = cardDavTarget(request.url, actor, contacts);
      if (target === null) {
        return reply.code(404).send("Unknown CardDAV resource.");
      }
      const depth = propfindDepth(headerString(request.headers.depth));
      return reply
        .code(207)
        .type("application/xml; charset=utf-8")
        .send(cardDavMultistatusXml(actor, target, contacts, depth, syncVersion));
    },
  });
}

type CardDavWriteTarget =
  | { readonly ok: true; readonly href: string }
  | { readonly ok: false; readonly status: 404 | 412; readonly message: string };

/**
 * Shared PUT/DELETE prologue: resolve the addressed contact href (the read-only
 * `self.vcf` card is never writable) and apply If-Match / If-None-Match.
 */
async function resolveCardDavWriteTarget(
  request: FastifyRequest,
  actor: Actor,
  store: CardDavContactStore,
): Promise<CardDavWriteTarget> {
  const href = contactHrefFromRequest(request.url, actor);
  if (href === null || href === "self.vcf") {
    return { ok: false, status: 404, message: "Unknown CardDAV contact." };
  }
  const existing = await store.getContactForActor({
    orgId: actor.orgId,
    actorId: actor.id,
    href,
  });
  const preconditionFailure = cardDavPreconditionFailure(request, existing);
  if (preconditionFailure !== null) {
    return { ok: false, status: 412, message: preconditionFailure };
  }
  return { ok: true, href };
}

async function authenticateCardDav(
  request: FastifyRequest,
  authenticator: AppPasswordAuthenticator,
  requiredScope: "carddav.read" | "carddav.write",
): Promise<Actor | null> {
  const credentials = parseBasicAuthorization(request.headers.authorization);
  if (credentials === null) {
    return null;
  }
  return authenticator.authenticateAppPassword({
    username: credentials.username,
    password: credentials.password,
    requiredScope,
    compatibilityScope: "carddav",
  });
}

type CardDavTarget =
  | { readonly kind: "addressbook" }
  | { readonly kind: "principal" }
  | { readonly kind: "self" }
  | { readonly kind: "contact"; readonly contact: CardDavContactRecord };

function cardDavMultistatusXml(
  actor: Actor,
  target: CardDavTarget,
  contacts: readonly CardDavContactRecord[],
  depth: 0 | 1,
  syncVersion: number,
): string {
  const responses = [targetResponseXml(actor, target, contacts, syncVersion)];
  if (depth === 1 && target.kind === "addressbook") {
    responses.push(
      selfCardResponseXml(actor),
      ...contacts.map((contact) => contactResponseXml(actor, contact)),
    );
  }
  return xmlDocument(multistatusXml(responses));
}

function cardDavReportXml(
  actor: Actor,
  contacts: readonly CardDavContactRecord[],
  bodyText: string,
): string {
  const requestedHrefs = reportHrefs(bodyText);
  if (isAddressbookMultigetReport(bodyText)) {
    const responses =
      requestedHrefs.length === 0
        ? fullAddressDataResponsesXml(actor, contacts)
        : requestedHrefs.map((href) => addressbookMultigetResponseXml(actor, contacts, href));
    return xmlDocument(multistatusXml(responses));
  }

  const responses: string[] = [];
  const shouldIncludeAll = requestedHrefs.length === 0;
  if (shouldIncludeAll || requestedHrefs.includes(selfCardHref(actor))) {
    responses.push(selfCardResponseXml(actor, { includeAddressData: true }));
  }
  for (const contact of contacts) {
    const href = contactHref(actor, contact);
    if (shouldIncludeAll || requestedHrefs.includes(href)) {
      responses.push(contactResponseXml(actor, contact, { includeAddressData: true }));
    }
  }
  return xmlDocument(multistatusXml(responses));
}

function cardDavSyncCollectionXml(
  actor: Actor,
  contacts: readonly CardDavContactRecord[],
  changes: readonly CardDavContactRecord[],
  syncVersion: number,
  sinceSyncVersion: number | undefined,
): string {
  const responses =
    sinceSyncVersion === undefined
      ? fullAddressDataResponsesXml(actor, contacts)
      : changes.map((contact) =>
          contact.deletedAt === undefined
            ? contactResponseXml(actor, contact, { includeAddressData: true })
            : deletedContactResponseXml(actor, contact),
        );
  return xmlDocument(multistatusXml(responses, syncToken(syncVersion)));
}

/** Full-collection listing: the self card plus every contact, address data inline. */
function fullAddressDataResponsesXml(
  actor: Actor,
  contacts: readonly CardDavContactRecord[],
): readonly string[] {
  return [
    selfCardResponseXml(actor, { includeAddressData: true }),
    ...contacts.map((contact) => contactResponseXml(actor, contact, { includeAddressData: true })),
  ];
}

function targetResponseXml(
  actor: Actor,
  target: CardDavTarget,
  contacts: readonly CardDavContactRecord[],
  syncVersion: number,
): string {
  if (target.kind === "principal") {
    return responseXml({
      href: principalHref(actor),
      displayName: actorDisplayName(actor),
      resourceType: "<D:principal/>",
      extraProps: `<C:addressbook-home-set><D:href>${xmlEscape(addressbookHref(actor))}</D:href></C:addressbook-home-set>`,
    });
  }
  if (target.kind === "self") {
    return selfCardResponseXml(actor);
  }
  if (target.kind === "contact") {
    return contactResponseXml(actor, target.contact);
  }
  return responseXml({
    href: addressbookHref(actor),
    displayName: "Contacts",
    resourceType: "<D:collection/><C:addressbook/>",
    extraProps: [
      `<D:current-user-principal><D:href>${xmlEscape(principalHref(actor))}</D:href></D:current-user-principal>`,
      `<C:addressbook-home-set><D:href>${xmlEscape(addressbookHref(actor))}</D:href></C:addressbook-home-set>`,
      '<C:supported-address-data><C:address-data-type content-type="text/vcard" version="4.0"/></C:supported-address-data>',
      [
        "<D:supported-report-set>",
        "<D:supported-report><D:report><C:addressbook-query/></D:report></D:supported-report>",
        "<D:supported-report><D:report><C:addressbook-multiget/></D:report></D:supported-report>",
        "<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>",
        "</D:supported-report-set>",
      ].join(""),
      `<D:sync-token>${xmlEscape(syncToken(syncVersion))}</D:sync-token>`,
    ].join(""),
  });
}

function selfCardResponseXml(
  actor: Actor,
  options: { readonly includeAddressData?: boolean } = {},
): string {
  const vcard = actorVcard(actor);
  return responseXml({
    href: selfCardHref(actor),
    displayName: "self.vcf",
    resourceType: "",
    extraProps: [
      "<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>",
      `<D:getcontentlength>${String(Buffer.byteLength(vcard))}</D:getcontentlength>`,
      `<D:getetag>${xmlEscape(selfCardEtag(actor))}</D:getetag>`,
      options.includeAddressData === true
        ? `<C:address-data>${xmlEscape(vcard)}</C:address-data>`
        : "",
    ].join(""),
  });
}

function contactResponseXml(
  actor: Actor,
  contact: CardDavContactRecord,
  options: { readonly includeAddressData?: boolean } = {},
): string {
  return responseXml({
    href: contactHref(actor, contact),
    displayName: contact.href,
    resourceType: "",
    extraProps: [
      "<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>",
      `<D:getcontentlength>${String(Buffer.byteLength(contact.vcard))}</D:getcontentlength>`,
      `<D:getetag>${xmlEscape(contact.etag)}</D:getetag>`,
      options.includeAddressData === true
        ? `<C:address-data>${xmlEscape(contact.vcard)}</C:address-data>`
        : "",
    ].join(""),
  });
}

function addressbookMultigetResponseXml(
  actor: Actor,
  contacts: readonly CardDavContactRecord[],
  href: string,
): string {
  if (href === selfCardHref(actor)) {
    return selfCardResponseXml(actor, { includeAddressData: true });
  }
  const prefix = addressbookHref(actor);
  if (href.startsWith(prefix)) {
    const contactHrefValue = decodeURIComponent(href.slice(prefix.length));
    const contact = contacts.find((candidate) => candidate.href === contactHrefValue);
    if (contact !== undefined) {
      return contactResponseXml(actor, contact, { includeAddressData: true });
    }
  }
  return notFoundResponseXml(href);
}

function deletedContactResponseXml(actor: Actor, contact: CardDavContactRecord): string {
  return notFoundResponseXml(contactHref(actor, contact));
}

function notFoundResponseXml(href: string): string {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
}

function responseXml(input: {
  readonly href: string;
  readonly displayName: string;
  readonly resourceType: string;
  readonly extraProps?: string;
}): string {
  return `<D:response><D:href>${xmlEscape(input.href)}</D:href><D:propstat><D:prop><D:displayname>${xmlEscape(input.displayName)}</D:displayname><D:resourcetype>${input.resourceType}</D:resourcetype>${input.extraProps ?? ""}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function cardDavTarget(
  url: string,
  actor: Actor,
  contacts: readonly CardDavContactRecord[],
): CardDavTarget | null {
  const path = requestPath(url);
  if (path.includes("/principals/")) {
    return { kind: "principal" };
  }
  if (path === addressbookHref(actor) || path === "/dav/card/" || path === "/dav/card") {
    return { kind: "addressbook" };
  }
  if (isSelfVcardRequest(url, actor)) {
    return { kind: "self" };
  }
  const href = contactHrefFromRequest(url, actor);
  if (href === null) {
    return null;
  }
  const contact = contacts.find((candidate) => candidate.href === href);
  return contact === undefined ? null : { kind: "contact", contact };
}

function isSelfVcardRequest(url: string, actor: Actor): boolean {
  const path = requestPath(url);
  return path === selfCardHref(actor) || path === `${selfCardHref(actor)}/`;
}

function contactHrefFromRequest(url: string, actor: Actor): string | null {
  const path = requestPath(url);
  const prefix = addressbookHref(actor);
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rawName = path.slice(prefix.length).replace(/\/$/, "");
  if (rawName.length === 0 || rawName.includes("/")) {
    return null;
  }
  const href = decodeURIComponent(rawName);
  return isValidContactHref(href) ? href : null;
}

function isValidContactHref(href: string): boolean {
  return (
    href.length > 4 &&
    href.length <= 180 &&
    href.endsWith(".vcf") &&
    !href.includes("/") &&
    !href.includes("\\") &&
    !href.includes("..")
  );
}

function reportHrefs(body: string): readonly string[] {
  return [...body.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)].map((match) =>
    xmlUnescape(match[1] ?? ""),
  );
}

function isSyncCollectionReport(body: string): boolean {
  return /<[^>]*sync-collection[\s>]/i.test(body);
}

function isAddressbookMultigetReport(body: string): boolean {
  return /<[^>]*addressbook-multiget[\s>]/i.test(body);
}

function syncCollectionVersion(body: string): number | undefined {
  const match = body.match(/<[^>]*sync-token[^>]*>([^<]*)<\/[^>]*sync-token>/i);
  const token = match?.[1]?.trim();
  if (token === undefined || token.length === 0) {
    return undefined;
  }
  const decoded = xmlUnescape(token);
  const version = decoded.match(/^data:,helix-carddav-sync-(\d+)$/)?.[1];
  return version === undefined ? undefined : Number(version);
}

function syncToken(syncVersion: number): string {
  return `data:,helix-carddav-sync-${String(syncVersion)}`;
}

function principalHref(actor: Actor): string {
  return `/dav/card/principals/${encodeURIComponent(actor.id)}/`;
}

function addressbookHref(actor: Actor): string {
  return `/dav/card/${encodeURIComponent(actor.id)}/`;
}

function selfCardHref(actor: Actor): string {
  return `${addressbookHref(actor)}self.vcf`;
}

function contactHref(actor: Actor, contact: CardDavContactRecord): string {
  return `${addressbookHref(actor)}${encodeURIComponent(contact.href)}`;
}

function actorVcard(actor: Actor): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `FN:${vcardEscape(actorDisplayName(actor))}`,
    `UID:${vcardEscape(actor.id)}`,
  ];
  if (actor.email !== undefined && actor.email.length > 0) {
    lines.push(`EMAIL:${vcardEscape(actor.email)}`);
  }
  lines.push("END:VCARD", "");
  return lines.join("\r\n");
}

function actorDisplayName(actor: Actor): string {
  return actor.displayName ?? actor.email ?? actor.id;
}

function selfCardEtag(actor: Actor): string {
  return `"self-${actor.id}-${actor.email ?? "no-email"}"`;
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

function bodyToString(body: unknown): string {
  return typeof body === "string" ? body : "";
}

function cardDavPreconditionFailure(
  request: FastifyRequest,
  existing: CardDavContactRecord | null,
): string | null {
  const ifNoneMatch = headerString(request.headers["if-none-match"]);
  if (ifNoneMatch?.trim() === "*" && existing !== null) {
    return "CardDAV contact already exists.";
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
    return "CardDAV contact does not exist.";
  }
  if (candidates.includes("*") || candidates.includes(existing.etag)) {
    return null;
  }
  return "CardDAV ETag precondition failed.";
}

function safeAddHttpMethod(
  app: FastifyInstance,
  method: string,
  options: { readonly hasBody: boolean },
): void {
  try {
    app.addHttpMethod(method, options);
  } catch {
    // A sibling DAV module may already have registered this extension method.
  }
}

function safeAddContentTypeParser(app: FastifyInstance, contentType: string): void {
  try {
    app.addContentTypeParser(contentType, { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });
  } catch {
    // Parser may already be registered by another DAV route module.
  }
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>${body}`;
}

function multistatusXml(responses: readonly string[], syncTokenValue?: string): string {
  const token =
    syncTokenValue === undefined ? "" : `<D:sync-token>${xmlEscape(syncTokenValue)}</D:sync-token>`;
  return `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${responses.join("")}${token}</D:multistatus>`;
}

function requestPath(url: string): string {
  return url.split("?")[0] ?? url;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function vcardEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,");
}
