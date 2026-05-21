import fastify, { type InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import { registerCardDavRoutes } from "./routes.js";
import { InMemoryCardDavContactStore } from "./store.js";

const actor: Actor = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId: "11111111-1111-4111-8111-111111111111",
  type: "user",
  email: "ada@example.test",
  displayName: "Ada Lovelace",
  scopes: ["profile.read"],
};

describe("CardDAV routes", () => {
  it("advertises read-only CardDAV methods and challenges unauthenticated clients", async () => {
    const app = await createApp();

    const options = await app.inject({ method: "OPTIONS", url: "/dav/card/" });
    const propfind = await app.inject({
      method: "PROPFIND",
      url: "/dav/card/",
    } as unknown as InjectOptions);

    expect(options.statusCode).toBe(204);
    expect(options.headers.dav).toBe("1, addressbook");
    expect(options.headers.allow).toBe("OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE");
    expect(propfind.statusCode).toBe(401);
    expect(propfind.headers["www-authenticate"]).toBe('Basic realm="Helix CardDAV"');
  });

  it("returns principal, home, addressbook, and self card metadata for PROPFIND", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "PROPFIND",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        depth: "1",
        "content-type": "application/xml",
      },
      payload: '<D:propfind xmlns:D="DAV:" />',
    } as unknown as InjectOptions);

    expect(response.statusCode).toBe(207);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(response.body).toContain("<D:current-user-principal>");
    expect(response.body).toContain(`<D:href>/dav/card/principals/${actor.id}/</D:href>`);
    expect(response.body).toContain("<C:addressbook-home-set>");
    expect(response.body).toContain("<D:collection/><C:addressbook/>");
    expect(response.body).toContain(`<D:href>/dav/card/${actor.id}/self.vcf</D:href>`);
    expect(response.body).toContain(
      "<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>",
    );
    expect(response.body).toContain("<D:supported-report-set>");
    expect(response.body).toContain("<C:addressbook-query/>");
    expect(response.body).toContain("<C:addressbook-multiget/>");
    expect(response.body).toContain("<D:sync-collection/>");
    expect(response.body).toContain("<D:sync-token>");
  });

  it("serves the authenticated actor as a deterministic vCard", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "GET",
      url: `/dav/card/${actor.id}/self.vcf`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/vcard");
    expect(response.headers.etag).toContain(actor.id);
    expect(response.body).toContain("BEGIN:VCARD");
    expect(response.body).toContain("VERSION:4.0");
    expect(response.body).toContain("FN:Ada Lovelace");
    expect(response.body).toContain("EMAIL:ada@example.test");
  });

  it("rejects app passwords without carddav scope", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "PROPFIND",
      url: "/dav/card/",
      headers: { authorization: basic("ada@example.test", "calendar") },
    } as unknown as InjectOptions);

    expect(response.statusCode).toBe(401);
  });

  it("imports, lists, reports, updates, and deletes stored vCard contacts", async () => {
    const app = await createApp();
    const contactUrl = `/dav/card/${actor.id}/grace.vcf`;
    const missingContactUrl = `/dav/card/${actor.id}/missing.vcf`;
    const created = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
      },
      payload: [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Grace Hopper",
        "UID:grace-hopper",
        "EMAIL:grace@example.test",
        "END:VCARD",
        "",
      ].join("\r\n"),
    } as unknown as InjectOptions);

    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toContain("contact-");

    const getCreated = await app.inject({
      method: "GET",
      url: contactUrl,
      headers: { authorization: basic("ada@example.test", "carddav") },
    });
    expect(getCreated.statusCode).toBe(200);
    expect(getCreated.headers.etag).toBe(created.headers.etag);
    expect(getCreated.body).toContain("FN:Grace Hopper");

    const propfind = await app.inject({
      method: "PROPFIND",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        depth: "1",
      },
    } as unknown as InjectOptions);
    expect(propfind.statusCode).toBe(207);
    expect(propfind.body).toContain(`<D:href>${contactUrl}</D:href>`);
    expect(propfind.body).toContain("<D:getetag>");

    const report = await app.inject({
      method: "REPORT",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "application/xml",
      },
      payload: `<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:href>${contactUrl}</D:href><D:href>${missingContactUrl}</D:href></C:addressbook-multiget>`,
    } as unknown as InjectOptions);
    expect(report.statusCode).toBe(207);
    expect(report.body).toContain("<C:address-data>");
    expect(report.body).toContain("Grace Hopper");
    expect(report.body).toContain(
      `<D:response><D:href>${missingContactUrl}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
    );

    const updated = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
      },
      payload: [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Rear Admiral Grace Hopper",
        "UID:grace-hopper",
        "EMAIL:grace@example.test",
        "END:VCARD",
        "",
      ].join("\r\n"),
    } as unknown as InjectOptions);
    expect(updated.statusCode).toBe(204);
    expect(updated.headers.etag).not.toBe(created.headers.etag);

    const deleted = await app.inject({
      method: "DELETE",
      url: contactUrl,
      headers: { authorization: basic("ada@example.test", "carddav") },
    } as unknown as InjectOptions);
    expect(deleted.statusCode).toBe(204);

    const getDeleted = await app.inject({
      method: "GET",
      url: contactUrl,
      headers: { authorization: basic("ada@example.test", "carddav") },
    });
    expect(getDeleted.statusCode).toBe(404);
  });

  it("enforces CardDAV PUT and DELETE ETag preconditions", async () => {
    const app = await createApp();
    const contactUrl = `/dav/card/${actor.id}/preconditions.vcf`;
    const created = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
        "if-none-match": "*",
      },
      payload: contactVcard("Precondition Contact", "precondition@example.test"),
    } as unknown as InjectOptions);
    expect(created.statusCode).toBe(201);
    const createdEtag = String(created.headers.etag);

    const createOnlyConflict = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
        "if-none-match": "*",
      },
      payload: contactVcard("Precondition Contact Again", "precondition@example.test"),
    } as unknown as InjectOptions);
    expect(createOnlyConflict.statusCode).toBe(412);

    const missingWithIfMatch = await app.inject({
      method: "PUT",
      url: `/dav/card/${actor.id}/missing-precondition.vcf`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
        "if-match": "*",
      },
      payload: contactVcard("Missing Contact", "missing@example.test"),
    } as unknown as InjectOptions);
    expect(missingWithIfMatch.statusCode).toBe(412);

    const staleUpdate = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
        "if-match": '"stale"',
      },
      payload: contactVcard("Stale Contact", "stale@example.test"),
    } as unknown as InjectOptions);
    expect(staleUpdate.statusCode).toBe(412);

    const currentUpdate = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
        "if-match": createdEtag,
      },
      payload: contactVcard("Updated Precondition Contact", "precondition@example.test"),
    } as unknown as InjectOptions);
    expect(currentUpdate.statusCode).toBe(204);
    const updatedEtag = String(currentUpdate.headers.etag);
    expect(updatedEtag).not.toBe(createdEtag);

    const staleDelete = await app.inject({
      method: "DELETE",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "if-match": createdEtag,
      },
    } as unknown as InjectOptions);
    expect(staleDelete.statusCode).toBe(412);

    const currentDelete = await app.inject({
      method: "DELETE",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "if-match": updatedEtag,
      },
    } as unknown as InjectOptions);
    expect(currentDelete.statusCode).toBe(204);
  });

  it("supports CardDAV sync-token discovery and sync-collection REPORT", async () => {
    const app = await createApp();
    const contactUrl = `/dav/card/${actor.id}/katherine.vcf`;
    await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
      },
      payload: [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Katherine Johnson",
        "UID:katherine-johnson",
        "EMAIL:katherine@example.test",
        "END:VCARD",
        "",
      ].join("\r\n"),
    } as unknown as InjectOptions);

    const propfind = await app.inject({
      method: "PROPFIND",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        depth: "0",
        "content-type": "application/xml",
      },
      payload:
        '<D:propfind xmlns:D="DAV:"><D:prop><D:sync-token /></D:prop></D:propfind>',
    } as unknown as InjectOptions);

    expect(propfind.statusCode).toBe(207);
    const token = syncTokenFromXml(propfind.body);
    expect(token).toContain("data:,helix-carddav-");

    const firstSync = await app.inject({
      method: "REPORT",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "application/xml",
      },
      payload:
        '<D:sync-collection xmlns:D="DAV:"><D:sync-token /></D:sync-collection>',
    } as unknown as InjectOptions);

    expect(firstSync.statusCode).toBe(207);
    expect(firstSync.body).toContain(`<D:href>${contactUrl}</D:href>`);
    expect(firstSync.body).toContain("Katherine Johnson");
    expect(syncTokenFromXml(firstSync.body)).toBe(token);

    const unchangedSync = await app.inject({
      method: "REPORT",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "application/xml",
      },
      payload: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token></D:sync-collection>`,
    } as unknown as InjectOptions);

    expect(unchangedSync.statusCode).toBe(207);
    expect(syncTokenFromXml(unchangedSync.body)).toBe(token);
    expect(unchangedSync.body).not.toContain(`<D:href>${contactUrl}</D:href>`);
    expect(unchangedSync.body).not.toContain("Katherine Johnson");

    const updated = await app.inject({
      method: "PUT",
      url: contactUrl,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "text/vcard",
      },
      payload: [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Katherine Coleman Johnson",
        "UID:katherine-johnson",
        "EMAIL:katherine@example.test",
        "END:VCARD",
        "",
      ].join("\r\n"),
    } as unknown as InjectOptions);
    expect(updated.statusCode).toBe(204);

    const afterUpdate = await propfindSyncToken(app, token);
    expect(afterUpdate).not.toBe(token);

    const updateDelta = await app.inject({
      method: "REPORT",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "application/xml",
      },
      payload: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token></D:sync-collection>`,
    } as unknown as InjectOptions);

    expect(updateDelta.statusCode).toBe(207);
    expect(syncTokenFromXml(updateDelta.body)).toBe(afterUpdate);
    expect(updateDelta.body).toContain(`<D:href>${contactUrl}</D:href>`);
    expect(updateDelta.body).toContain("Katherine Coleman Johnson");
    expect(updateDelta.body).toContain("HTTP/1.1 200 OK");

    const deleted = await app.inject({
      method: "DELETE",
      url: contactUrl,
      headers: { authorization: basic("ada@example.test", "carddav") },
    } as unknown as InjectOptions);
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await propfindSyncToken(app, afterUpdate);
    expect(afterDelete).not.toBe(afterUpdate);

    const deleteDelta = await app.inject({
      method: "REPORT",
      url: `/dav/card/${actor.id}/`,
      headers: {
        authorization: basic("ada@example.test", "carddav"),
        "content-type": "application/xml",
      },
      payload: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${afterUpdate}</D:sync-token></D:sync-collection>`,
    } as unknown as InjectOptions);

    expect(deleteDelta.statusCode).toBe(207);
    expect(syncTokenFromXml(deleteDelta.body)).toBe(afterDelete);
    expect(deleteDelta.body).toContain(`<D:href>${contactUrl}</D:href>`);
    expect(deleteDelta.body).toContain("HTTP/1.1 404 Not Found");
    expect(deleteDelta.body).not.toContain("<C:address-data>");
    expect(deleteDelta.body).not.toContain("<D:getetag>");
  });

  it("requires write scope for contact imports and rejects invalid vCards", async () => {
    const app = await createApp();

    const readOnlyWrite = await app.inject({
      method: "PUT",
      url: `/dav/card/${actor.id}/read-only.vcf`,
      headers: {
        authorization: basic("ada@example.test", "carddav.read"),
        "content-type": "text/vcard",
      },
      payload: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Read Only\r\nEND:VCARD\r\n",
    } as unknown as InjectOptions);
    expect(readOnlyWrite.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "PUT",
      url: `/dav/card/${actor.id}/invalid.vcf`,
      headers: {
        authorization: basic("ada@example.test", "carddav.write"),
        "content-type": "text/vcard",
      },
      payload: "not a vcard",
    } as unknown as InjectOptions);
    expect(invalid.statusCode).toBe(400);

    const crossActor = await app.inject({
      method: "PUT",
      url: "/dav/card/33333333-3333-4333-8333-333333333333/contact.vcf",
      headers: {
        authorization: basic("ada@example.test", "carddav.write"),
        "content-type": "text/vcard",
      },
      payload: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Wrong Book\r\nEND:VCARD\r\n",
    } as unknown as InjectOptions);
    expect(crossActor.statusCode).toBe(404);
  });
});

class FakeAppPasswordAuthenticator implements AppPasswordAuthenticator {
  async authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
    readonly compatibilityScope?: string | undefined;
  }): Promise<Actor | null> {
    if (input.username !== actor.email) {
      return null;
    }
    const scopes = input.password.split(",");
    if (
      !scopes.includes(input.requiredScope) &&
      (input.compatibilityScope === undefined || !scopes.includes(input.compatibilityScope))
    ) {
      return null;
    }
    return { ...actor, scopes: [...(actor.scopes ?? []), ...scopes] };
  }
}

async function createApp() {
  const app = fastify();
  await registerCardDavRoutes(app, {
    appPasswords: new FakeAppPasswordAuthenticator(),
    store: new InMemoryCardDavContactStore(),
  });
  return app;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function contactVcard(name: string, email: string): string {
  return [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `FN:${name}`,
    `UID:${email}`,
    `EMAIL:${email}`,
    "END:VCARD",
    "",
  ].join("\r\n");
}

async function propfindSyncToken(
  app: Awaited<ReturnType<typeof createApp>>,
  previousToken: string,
): Promise<string> {
  const response = await app.inject({
    method: "PROPFIND",
    url: `/dav/card/${actor.id}/`,
    headers: {
      authorization: basic("ada@example.test", "carddav"),
      depth: "0",
      "content-type": "application/xml",
    },
    payload: `<D:propfind xmlns:D="DAV:"><D:prop><D:sync-token>${previousToken}</D:sync-token></D:prop></D:propfind>`,
  } as unknown as InjectOptions);
  expect(response.statusCode).toBe(207);
  return syncTokenFromXml(response.body);
}

function syncTokenFromXml(xml: string): string {
  const token = xml.match(/<D:sync-token>([^<]+)<\/D:sync-token>/)?.[1];
  if (token === undefined) {
    throw new Error("Expected sync-token in XML response.");
  }
  return token
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
