import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DAV_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import { versionedApiPath } from "../../api/version.js";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import {
  DavStandardsParseError,
  davElements,
  davText,
  decodePathSegment,
  parseDavXml,
} from "../dav/standards.js";
import { parseBasicAuthorization } from "../util/http-auth.js";
import {
  CardDavAccessError,
  InvalidVcardError,
  type CardDavContactFilter,
  type CardDavContactRecord,
  type CardDavContactStore,
} from "./store.js";

const CARD_DAV_PAGE_LIMIT = 500;

export interface RegisterCardDavRoutesOptions {
  readonly appPasswords: AppPasswordAuthenticator;
  readonly store: CardDavContactStore;
}

type CardDavMethod = "PROPFIND" | "REPORT" | "GET" | "PUT" | "DELETE" | "MKCOL" | "ACL";

export async function registerCardDavRoutes(
  app: FastifyInstance,
  options: RegisterCardDavRoutesOptions,
): Promise<void> {
  safeAddHttpMethod(app, "PROPFIND", { hasBody: true });
  safeAddHttpMethod(app, "REPORT", { hasBody: true });
  safeAddHttpMethod(app, "MKCOL", { hasBody: true });
  safeAddHttpMethod(app, "ACL", { hasBody: true });
  safeAddContentTypeParser(app, "application/xml");
  safeAddContentTypeParser(app, "text/xml");
  safeAddContentTypeParser(app, "text/vcard");
  safeAddContentTypeParser(app, "text/x-vcard");

  app.route({
    method: "OPTIONS",
    url: "/dav/card/*",
    handler: async (_request, reply) =>
      reply
        .header("DAV", "1, 3, addressbook, extended-mkcol, sync-collection")
        .header("Allow", "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, MKCOL, ACL")
        .code(204)
        .send(),
  });

  app.route({
    method: ["PROPFIND", "REPORT", "GET", "PUT", "DELETE", "MKCOL", "ACL"],
    url: "/dav/card/*",
    bodyLimit: DAV_BODY_LIMIT_BYTES,
    handler: async (request, reply) => {
      const method = request.method as CardDavMethod;
      const actor = await authenticateCardDav(
        request,
        options.appPasswords,
        method === "PUT" || method === "DELETE" || method === "MKCOL" || method === "ACL"
          ? "carddav.write"
          : "carddav.read",
      );
      if (actor === null) {
        return reply
          .header("www-authenticate", 'Basic realm="Helix CardDAV"')
          .code(401)
          .send("CardDAV app password required.");
      }
      const addressBookId = addressBookIdFromRequest(request.url, actor);
      const davBodyText = bodyToString(request.body);
      if (
        (method === "PROPFIND" || method === "REPORT" || method === "MKCOL" || method === "ACL") &&
        davBodyText.trim().length > 0
      ) {
        try {
          parseDavXml(davBodyText);
          if (method === "REPORT") {
            reportLimit(davBodyText);
            if (isSyncCollectionReport(davBodyText)) {
              syncCollectionVersion(davBodyText);
            } else if (!isAddressbookMultigetReport(davBodyText)) {
              addressbookFilter(davBodyText);
              reportPageToken(davBodyText);
            }
          }
        } catch (error) {
          if (error instanceof DavStandardsParseError) return reply.code(400).send(error.message);
          throw error;
        }
      }

      if (method === "MKCOL") {
        if (
          addressBookId === undefined ||
          requestPath(request.url) !== addressbookHref(actor, addressBookId)
        ) {
          return reply.code(400).send("CardDAV MKCOL requires a UUID address-book path.");
        }
        const displayName =
          (davBodyText.trim().length === 0
            ? ""
            : davText(davElements(parseDavXml(davBodyText), "displayname")[0]).trim()) ||
          "Contacts";
        if (displayName.length > 255) return reply.code(400).send("Address-book name is too long.");
        const created = await options.store.createAddressBook({
          orgId: actor.orgId,
          actorId: actor.id,
          addressBookId,
          displayName,
        });
        return created === null
          ? reply.code(409).send("CardDAV address book already exists.")
          : reply.header("Location", addressbookHref(actor, addressBookId)).code(201).send();
      }

      if (method === "ACL") {
        if (addressBookId === undefined) return reply.code(400).send("Address-book id required.");
        const grant = addressBookGrant(davBodyText);
        if (grant === null) return reply.code(400).send("A valid CardDAV ACL grant is required.");
        const shared = await options.store.shareAddressBook({
          orgId: actor.orgId,
          actorId: actor.id,
          addressBookId,
          memberActorId: grant.actorId,
          role: grant.role,
        });
        return shared
          ? reply.code(204).send()
          : reply.code(403).send("Only the address-book owner may share it.");
      }

      if (method === "PROPFIND" && isAddressBookListRequest(request.url, actor)) {
        const books = await options.store.listAddressBooksForActor({
          orgId: actor.orgId,
          actorId: actor.id,
        });
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(addressBookListXml(actor, books));
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
          ...(addressBookId === undefined ? {} : { addressBookId }),
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
        const href = contactHrefFromRequest(request.url, actor);
        if (href === null || href === "self.vcf") {
          return reply.code(404).send("Unknown CardDAV contact.");
        }
        const existing = await options.store.getContactForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          ...(addressBookId === undefined ? {} : { addressBookId }),
          href,
        });
        const preconditionFailure = cardDavPreconditionFailure(request, existing);
        if (preconditionFailure !== null) {
          return reply.code(412).send(preconditionFailure);
        }
        try {
          const result = await options.store.upsertContactFromVcard({
            orgId: actor.orgId,
            actorId: actor.id,
            ...(addressBookId === undefined ? {} : { addressBookId }),
            href,
            vcard: bodyToString(request.body),
          });
          return await reply
            .header("ETag", result.contact.etag)
            .header("Location", contactHref(actor, result.contact, addressBookId))
            .code(result.created ? 201 : 204)
            .send();
        } catch (error) {
          if (error instanceof CardDavAccessError) {
            return await reply.code(403).send(error.message);
          }
          if (error instanceof InvalidVcardError) {
            return await reply.code(400).send(error.message);
          }
          throw error;
        }
      }

      if (method === "DELETE") {
        const href = contactHrefFromRequest(request.url, actor);
        if (href === null || href === "self.vcf") {
          return reply.code(404).send("Unknown CardDAV contact.");
        }
        const existing = await options.store.getContactForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          ...(addressBookId === undefined ? {} : { addressBookId }),
          href,
        });
        const preconditionFailure = cardDavPreconditionFailure(request, existing);
        if (preconditionFailure !== null) {
          return reply.code(412).send(preconditionFailure);
        }
        const deleted = await options.store.deleteContact({
          orgId: actor.orgId,
          actorId: actor.id,
          ...(addressBookId === undefined ? {} : { addressBookId }),
          href,
        });
        return deleted ? reply.code(204).send() : reply.code(404).send("Unknown CardDAV contact.");
      }

      if (method === "REPORT") {
        const bodyText = davBodyText;
        const limit = reportLimit(bodyText);
        if (isSyncCollectionReport(bodyText)) {
          const sinceSyncVersion = syncCollectionVersion(bodyText);
          const changes = await options.store.listContactChangesForActor({
            orgId: actor.orgId,
            actorId: actor.id,
            ...(addressBookId === undefined ? {} : { addressBookId }),
            sinceSyncVersion: sinceSyncVersion ?? 0,
            limit: limit + 1,
          });
          const truncated = changes.length > limit;
          const page = changes.slice(0, limit);
          const syncVersion = truncated
            ? (page.at(-1)?.syncVersion ?? sinceSyncVersion ?? 0)
            : await options.store.getContactSyncVersionForActor({
                orgId: actor.orgId,
                actorId: actor.id,
                ...(addressBookId === undefined ? {} : { addressBookId }),
              });
          return reply
            .code(207)
            .type("application/xml; charset=utf-8")
            .send(
              cardDavSyncCollectionXml(
                actor,
                page,
                syncVersion,
                sinceSyncVersion,
                truncated,
                addressBookId,
              ),
            );
        }
        const afterHref = reportPageToken(bodyText);
        const contacts = await options.store.listContactsForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          ...(addressBookId === undefined ? {} : { addressBookId }),
          limit: limit + 1,
          ...(afterHref === undefined ? {} : { afterHref }),
          ...(isAddressbookMultigetReport(bodyText) ? {} : { filter: addressbookFilter(bodyText) }),
        });
        const truncated = contacts.length > limit;
        const page = contacts.slice(0, limit);
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(cardDavReportXml(actor, page, bodyText, truncated, addressBookId));
      }

      const contacts = await options.store.listContactsForActor({
        orgId: actor.orgId,
        actorId: actor.id,
        ...(addressBookId === undefined ? {} : { addressBookId }),
        limit: CARD_DAV_PAGE_LIMIT + 1,
      });
      const syncVersion = await options.store.getContactSyncVersionForActor({
        orgId: actor.orgId,
        actorId: actor.id,
        ...(addressBookId === undefined ? {} : { addressBookId }),
      });
      const target = cardDavTarget(request.url, actor, contacts, addressBookId);
      if (target === null) {
        return reply.code(404).send("Unknown CardDAV resource.");
      }
      const depth = propfindDepth(headerString(request.headers.depth));
      return reply
        .code(207)
        .type("application/xml; charset=utf-8")
        .send(
          cardDavMultistatusXml(
            actor,
            target,
            contacts.slice(0, CARD_DAV_PAGE_LIMIT),
            depth,
            syncVersion,
            contacts.length > CARD_DAV_PAGE_LIMIT,
            addressBookId,
          ),
        );
    },
  });
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
  truncated = false,
  addressBookId?: string,
): string {
  const responses = [targetResponseXml(actor, target, contacts, syncVersion, addressBookId)];
  if (depth === 1 && target.kind === "addressbook") {
    responses.push(
      selfCardResponseXml(actor),
      ...contacts.map((contact) => contactResponseXml(actor, contact, {}, addressBookId)),
    );
  }
  if (truncated) responses.push(limitExceededResponseXml());
  return xmlDocument(multistatusXml(responses));
}

function addressBookListXml(
  actor: Actor,
  books: Awaited<ReturnType<CardDavContactStore["listAddressBooksForActor"]>>,
): string {
  return xmlDocument(
    multistatusXml(
      books.map((book) =>
        responseXml({
          href: addressbookHref(actor, book.id),
          displayName: book.displayName,
          resourceType: "<D:collection/><C:addressbook/>",
          extraProps: book.canWrite
            ? "<D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>"
            : "<D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>",
        }),
      ),
    ),
  );
}

function cardDavReportXml(
  actor: Actor,
  contacts: readonly CardDavContactRecord[],
  bodyText: string,
  truncated: boolean,
  addressBookId?: string,
): string {
  const requestedHrefs = reportHrefs(bodyText);
  if (isAddressbookMultigetReport(bodyText)) {
    const responses =
      requestedHrefs.length === 0
        ? [
            selfCardResponseXml(actor, { includeAddressData: true }),
            ...contacts.map((contact) =>
              contactResponseXml(actor, contact, { includeAddressData: true }, addressBookId),
            ),
          ]
        : requestedHrefs.map((href) =>
            addressbookMultigetResponseXml(actor, contacts, href, addressBookId),
          );
    if (truncated) responses.push(limitExceededResponseXml());
    return xmlDocument(multistatusXml(responses));
  }

  const responses: string[] = [];
  const shouldIncludeAll = requestedHrefs.length === 0;
  if (shouldIncludeAll || requestedHrefs.includes(selfCardHref(actor))) {
    responses.push(selfCardResponseXml(actor, { includeAddressData: true }));
  }
  for (const contact of contacts) {
    const href = contactHref(actor, contact, addressBookId);
    if (shouldIncludeAll || requestedHrefs.includes(href)) {
      responses.push(
        contactResponseXml(actor, contact, { includeAddressData: true }, addressBookId),
      );
    }
  }
  if (truncated) responses.push(limitExceededResponseXml(contacts.at(-1)?.href));
  return xmlDocument(multistatusXml(responses));
}

function cardDavSyncCollectionXml(
  actor: Actor,
  changes: readonly CardDavContactRecord[],
  syncVersion: number,
  sinceSyncVersion: number | undefined,
  truncated: boolean,
  addressBookId?: string,
): string {
  const responses =
    sinceSyncVersion === undefined
      ? [
          selfCardResponseXml(actor, { includeAddressData: true }),
          ...changes
            .filter((contact) => contact.deletedAt === undefined)
            .map((contact) =>
              contactResponseXml(actor, contact, { includeAddressData: true }, addressBookId),
            ),
        ]
      : changes.map((contact) =>
          contact.deletedAt === undefined
            ? contactResponseXml(actor, contact, { includeAddressData: true }, addressBookId)
            : deletedContactResponseXml(actor, contact, addressBookId),
        );
  if (truncated) responses.push(limitExceededResponseXml());
  return xmlDocument(multistatusXml(responses, syncToken(syncVersion)));
}

function targetResponseXml(
  actor: Actor,
  target: CardDavTarget,
  contacts: readonly CardDavContactRecord[],
  syncVersion: number,
  addressBookId?: string,
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
    return contactResponseXml(actor, target.contact, {}, addressBookId);
  }
  return responseXml({
    href: addressbookHref(actor, addressBookId),
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
  addressBookId?: string,
): string {
  return responseXml({
    href: contactHref(actor, contact, addressBookId),
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
  addressBookId?: string,
): string {
  href = requestPath(href);
  if (href === selfCardHref(actor)) {
    return selfCardResponseXml(actor, { includeAddressData: true });
  }
  const prefix = addressbookHref(actor, addressBookId);
  if (href.startsWith(prefix)) {
    const contactHrefValue = safeDecodePathSegment(href.slice(prefix.length));
    if (contactHrefValue === null) return notFoundResponseXml(href);
    const contact = contacts.find((candidate) => candidate.href === contactHrefValue);
    if (contact !== undefined) {
      return contactResponseXml(actor, contact, { includeAddressData: true }, addressBookId);
    }
  }
  return notFoundResponseXml(href);
}

function deletedContactResponseXml(
  actor: Actor,
  contact: CardDavContactRecord,
  addressBookId?: string,
): string {
  return notFoundResponseXml(contactHref(actor, contact, addressBookId));
}

function notFoundResponseXml(href: string): string {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
}

function limitExceededResponseXml(lastHref?: string): string {
  const next =
    lastHref === undefined
      ? ""
      : `<H:next-page-token>${Buffer.from(lastHref, "utf8").toString("base64url")}</H:next-page-token>`;
  return `<D:response><D:href></D:href><D:status>HTTP/1.1 507 Insufficient Storage</D:status><D:error><D:number-of-matches-within-limits/>${next}</D:error></D:response>`;
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
  addressBookId?: string,
): CardDavTarget | null {
  const path = requestPath(url);
  if (path.includes("/principals/")) {
    return { kind: "principal" };
  }
  if (
    path === addressbookHref(actor, addressBookId) ||
    path === `${addressbookHref(actor, addressBookId)}/` ||
    (addressBookId === undefined &&
      (path === versionedApiPath("/dav/card/") || path === versionedApiPath("/dav/card")))
  ) {
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

function isAddressBookListRequest(url: string, actor: Actor): boolean {
  const path = requestPath(url);
  const href = `${addressbookHref(actor)}books`;
  return path === href || path === `${href}/`;
}

function contactHrefFromRequest(url: string, actor: Actor): string | null {
  const path = requestPath(url);
  const prefix = addressbookHref(actor, addressBookIdFromRequest(url, actor));
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rawName = path.slice(prefix.length).replace(/\/$/, "");
  if (rawName.length === 0 || rawName.includes("/")) {
    return null;
  }
  const href = safeDecodePathSegment(rawName);
  if (href === null) return null;
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
  return davElements(parseDavXml(body), "href").map((element) => davText(element));
}

function reportLimit(body: string): number {
  const value = davText(davElements(parseDavXml(body), "nresults")[0]).trim();
  if (value.length === 0) return CARD_DAV_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new DavStandardsParseError("xml", "invalid");
  return Math.min(parsed, 1000);
}

function reportPageToken(body: string): string | undefined {
  const value = davText(davElements(parseDavXml(body), "page-token")[0]).trim();
  if (value.length === 0) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!isValidContactHref(decoded)) throw new DavStandardsParseError("xml", "invalid");
    return decoded;
  } catch {
    throw new DavStandardsParseError("xml", "invalid");
  }
}

function addressbookFilter(body: string): CardDavContactFilter | undefined {
  const property = davElements(parseDavXml(body), "prop-filter")[0];
  if (property === undefined) return undefined;
  const propertyName = property.attributes.name?.toUpperCase();
  if (propertyName !== "FN" && propertyName !== "EMAIL" && propertyName !== "UID") {
    throw new DavStandardsParseError("xml", "invalid");
  }
  const match = davElements(property, "text-match")[0];
  if (match === undefined) return undefined;
  const matchType = match.attributes["match-type"] ?? "contains";
  if (
    matchType !== "contains" &&
    matchType !== "equals" &&
    matchType !== "starts-with" &&
    matchType !== "ends-with"
  ) {
    throw new DavStandardsParseError("xml", "invalid");
  }
  return {
    property: propertyName,
    value: davText(match),
    matchType,
    negate: match.attributes["negate-condition"] === "yes",
  };
}

function addressBookGrant(
  body: string,
): { readonly actorId: string; readonly role: "viewer" | "editor" } | null {
  if (body.trim().length === 0) return null;
  const href = davElements(parseDavXml(body), "href")
    .map((node) => davText(node).trim())
    .find((value) => value.includes("/principals/"));
  const actorId = href?.match(/\/principals\/([0-9a-f-]{36})\/?$/iu)?.[1];
  if (
    actorId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(actorId)
  ) {
    return null;
  }
  return {
    actorId,
    role: davElements(parseDavXml(body), "write").length > 0 ? "editor" : "viewer",
  };
}

function isSyncCollectionReport(body: string): boolean {
  return davElements(parseDavXml(body), "sync-collection").length > 0;
}

function isAddressbookMultigetReport(body: string): boolean {
  return davElements(parseDavXml(body), "addressbook-multiget").length > 0;
}

function syncCollectionVersion(body: string): number | undefined {
  const token = davText(davElements(parseDavXml(body), "sync-token")[0]).trim();
  if (token.length === 0) return undefined;
  const decoded = token;
  const version = decoded.match(/^data:,helix-carddav-sync-(\d+)$/)?.[1];
  if (version === undefined) throw new DavStandardsParseError("xml", "invalid");
  return Number(version);
}

function syncToken(syncVersion: number): string {
  return `data:,helix-carddav-sync-${String(syncVersion)}`;
}

function principalHref(actor: Actor): string {
  return versionedApiPath(`/dav/card/principals/${encodeURIComponent(actor.id)}/`);
}

function addressbookHref(actor: Actor, addressBookId?: string): string {
  return addressBookId === undefined
    ? versionedApiPath(`/dav/card/${encodeURIComponent(actor.id)}/`)
    : versionedApiPath(
        `/dav/card/${encodeURIComponent(actor.id)}/books/${encodeURIComponent(addressBookId)}/`,
      );
}

function selfCardHref(actor: Actor): string {
  return `${addressbookHref(actor)}self.vcf`;
}

function contactHref(actor: Actor, contact: CardDavContactRecord, addressBookId?: string): string {
  return `${addressbookHref(actor, addressBookId)}${encodeURIComponent(contact.href)}`;
}

function addressBookIdFromRequest(url: string, actor: Actor): string | undefined {
  const prefix = versionedApiPath(`/dav/card/${encodeURIComponent(actor.id)}/books/`);
  const path = requestPath(url);
  if (!path.startsWith(prefix)) return undefined;
  const value = path.slice(prefix.length).split("/")[0];
  if (value === undefined) return undefined;
  const decoded = safeDecodePathSegment(value);
  return decoded !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded)
    ? decoded
    : undefined;
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
  return `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:H="urn:helix:params:xml:ns:carddav">${responses.join("")}${token}</D:multistatus>`;
}

function requestPath(url: string): string {
  return versionedApiPath(url.split("?")[0] ?? url);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeDecodePathSegment(value: string): string | null {
  try {
    return decodePathSegment(value);
  } catch (error) {
    if (error instanceof DavStandardsParseError) return null;
    throw error;
  }
}

function vcardEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,");
}
