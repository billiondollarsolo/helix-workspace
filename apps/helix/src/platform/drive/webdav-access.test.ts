import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import { registerDriveRoutes, type WebDavDriveStore } from "./routes.js";
import type { DriveEntryRecord } from "./types.js";
import {
  authorizeWebDavAccess,
  isWebDavListable,
  WEBDAV_ACTOR_REQUEST_LIMIT,
  WEBDAV_AUTH_FAILURE_LIMIT,
} from "./webdav-access.js";
import { createWebDavRateLimiter } from "./webdav-security.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-10T12:00:00.000Z");

/** Accepts `ada@example.test`; the password names the scopes it carries. */
class ScopedAuthenticator implements AppPasswordAuthenticator {
  calls = 0;
  async authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
    readonly compatibilityScope?: string;
  }): Promise<Actor | null> {
    this.calls += 1;
    if (input.username !== "ada@example.test" || input.password === "wrong") return null;
    const scopes = input.password.split("+");
    if (!scopes.includes(input.requiredScope) && !scopes.includes(input.compatibilityScope ?? "")) {
      return null;
    }
    return { id: actorId, orgId, type: "user", displayName: "Ada", scopes };
  }
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function access(password: string | null, overrides: { ip?: string; mutation?: boolean } = {}) {
  return {
    authorization: password === null ? undefined : basic("ada@example.test", password),
    ip: overrides.ip ?? "203.0.113.7",
    requiredScope: "drive.read" as const,
    mutation: overrides.mutation ?? false,
  };
}

describe("WebDAV access control", () => {
  it("does not spend the per-IP auth bucket on successful requests", async () => {
    const authenticator = new ScopedAuthenticator();
    const rateLimiter = createWebDavRateLimiter(() => 0);
    for (let i = 0; i < WEBDAV_AUTH_FAILURE_LIMIT * 10; i += 1) {
      const decision = await authorizeWebDavAccess({
        ...access("drive.read"),
        authenticator,
        rateLimiter,
      });
      expect(decision.ok).toBe(true);
    }
    expect(rateLimiter.peek("auth:203.0.113.7", 1, 60_000).allowed).toBe(true);
  });

  it("charges the per-IP bucket on failed credentials and blocks before verifying", async () => {
    const authenticator = new ScopedAuthenticator();
    const rateLimiter = createWebDavRateLimiter(() => 0);
    for (let i = 0; i < WEBDAV_AUTH_FAILURE_LIMIT; i += 1) {
      const decision = await authorizeWebDavAccess({
        ...access("wrong"),
        authenticator,
        rateLimiter,
      });
      expect(decision).toMatchObject({ ok: false, status: 401 });
    }
    const callsBefore = authenticator.calls;
    const blocked = await authorizeWebDavAccess({
      ...access("drive.read"),
      authenticator,
      rateLimiter,
    });
    expect(blocked).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 60 });
    expect(authenticator.calls).toBe(callsBefore);
    const otherIp = await authorizeWebDavAccess({
      ...access("drive.read", { ip: "198.51.100.2" }),
      authenticator,
      rateLimiter,
    });
    expect(otherIp.ok).toBe(true);
  });

  it("does not charge the IP bucket for the anonymous Basic challenge", async () => {
    const rateLimiter = createWebDavRateLimiter(() => 0);
    for (let i = 0; i < WEBDAV_AUTH_FAILURE_LIMIT + 5; i += 1) {
      const decision = await authorizeWebDavAccess({
        ...access(null),
        authenticator: new ScopedAuthenticator(),
        rateLimiter,
      });
      expect(decision).toMatchObject({ ok: false, status: 401 });
    }
    expect(rateLimiter.peek("auth:203.0.113.7", 1, 60_000).allowed).toBe(true);
  });

  it("bounds authenticated traffic per actor and mutations separately", async () => {
    const authenticator = new ScopedAuthenticator();
    const rateLimiter = createWebDavRateLimiter(() => 0);
    let lastRead;
    for (let i = 0; i <= WEBDAV_ACTOR_REQUEST_LIMIT; i += 1) {
      lastRead = await authorizeWebDavAccess({
        ...access("drive.read"),
        authenticator,
        rateLimiter,
      });
    }
    expect(lastRead).toMatchObject({
      ok: false,
      status: 429,
      message: "WebDAV request rate limit exceeded.",
    });

    const mutations = createWebDavRateLimiter(() => 0);
    const results = [];
    for (let i = 0; i <= 120; i += 1) {
      results.push(
        await authorizeWebDavAccess({
          ...access("drive.read", { mutation: true }),
          authenticator,
          rateLimiter: mutations,
        }),
      );
    }
    expect(results.at(-1)).toMatchObject({ message: "WebDAV mutation rate limit exceeded." });
  });

  it("returns 403 naming the missing scope when credentials are valid", async () => {
    const rateLimiter = createWebDavRateLimiter(() => 0);
    const decision = await authorizeWebDavAccess({
      ...access("drive.read+drive.write"),
      requiredScope: "drive.delete",
      authenticator: new ScopedAuthenticator(),
      rateLimiter,
    });
    expect(decision).toMatchObject({ ok: false, status: 403 });
    expect(decision.ok ? "" : decision.message).toContain('"drive.delete" scope');
    expect(decision.ok ? "" : decision.message).toContain("Desktop sync (WebDAV)");
    expect(rateLimiter.peek("auth:203.0.113.7", 1, 60_000).allowed).toBe(true);
  });

  it("only lists folders and files whose content is available", () => {
    const base = { folderId: null, ownerActorId: actorId, metadata: {}, deletedAt: null };
    const entry = (patch: Partial<DriveEntryRecord>): DriveEntryRecord => ({
      id: "x",
      type: "file",
      name: "x",
      createdAt: now,
      updatedAt: now,
      ...base,
      ...patch,
    });
    expect(isWebDavListable(entry({ type: "folder" }))).toBe(true);
    expect(isWebDavListable(entry({}))).toBe(true);
    expect(isWebDavListable(entry({ uploadState: "active", available: true }))).toBe(true);
    expect(isWebDavListable(entry({ uploadState: "scanning", available: false }))).toBe(false);
    expect(isWebDavListable(entry({ uploadState: "quarantined", available: false }))).toBe(false);
  });
});

describe("WebDAV routes for desktop sync", () => {
  const ready = file("ready.txt", "active", true);
  const scanning = file("pending.txt", "scanning", false);
  const quarantined = file("infected.bin", "quarantined", false);

  async function app() {
    const store = {
      list: async () => ({ entries: [ready, scanning, quarantined], nextCursor: null }),
      listWebDavLocks: async () => [],
      listWebDavChanges: async () => ({ valid: true, version: "1", changes: [], hasMore: false }),
    } as unknown as WebDavDriveStore;
    const server = fastify();
    await registerDriveRoutes(server, {
      store,
      appPasswords: new ScopedAuthenticator(),
      requireTls: false,
    });
    return server;
  }

  function propfind(server: Awaited<ReturnType<typeof app>>, url: string, password: string) {
    return server.inject({
      method: "PROPFIND" as "GET",
      url,
      headers: { authorization: basic("ada@example.test", password), depth: "1" },
    });
  }

  it("serves a first sync of many requests from one IP without auth throttling", async () => {
    const server = await app();
    const statuses = new Set<number>();
    for (let i = 0; i < WEBDAV_AUTH_FAILURE_LIMIT * 5; i += 1) {
      statuses.add((await propfind(server, "/dav/files/", "drive.read")).statusCode);
    }
    expect([...statuses]).toEqual([207]);
  });

  it("omits scanning and quarantined files from PROPFIND listings", async () => {
    const server = await app();
    const listing = await propfind(server, "/dav/files/", "drive.read");
    expect(listing.statusCode).toBe(207);
    expect(listing.body).toContain("/dav/files/ready.txt");
    expect(listing.body).not.toContain("pending.txt");
    expect(listing.body).not.toContain("infected.bin");
    expect((await propfind(server, "/dav/files/pending.txt", "drive.read")).statusCode).toBe(404);
  });

  it("answers a valid password without the required scope with 403", async () => {
    const server = await app();
    const response = await server.inject({
      method: "DELETE",
      url: "/dav/files/ready.txt",
      headers: { authorization: basic("ada@example.test", "drive.read+drive.write") },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('"drive.delete" scope');
    const wrong = await propfind(server, "/dav/files/", "wrong");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers["www-authenticate"]).toContain("Basic");
  });
});

function file(
  name: string,
  uploadState: "active" | "scanning" | "quarantined",
  available: boolean,
) {
  return {
    id: `id-${name}`,
    type: "file",
    name,
    folderId: null,
    ownerActorId: actorId,
    mimeType: "text/plain",
    byteSize: 1,
    uploadState,
    available,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies DriveEntryRecord;
}
