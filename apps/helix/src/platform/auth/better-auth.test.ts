import type { JsonObject, MeteringClient, MeteringEvent, TraceContext } from "@helix/sdk";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  ActorQuotaExceededError,
  BetterAuthVerifiedEmailRequiredError,
  createBetterAuthPlatformModule,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthSessionIssuer,
  PostgresBetterAuthUserLinkStore,
  sessionCookiePolicyForBaseUrl,
  type BetterAuthSessionVerifier,
} from "./better-auth.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface RecordedMeteringEvent {
  readonly orgId: string;
  readonly event: MeteringEvent;
  readonly trace?: TraceContext;
}

describe("PostgresBetterAuthActorStore", () => {
  it("finds active user actors by BetterAuth user id in metadata", async () => {
    const metadata = betterAuthMetadata("auth-user-1");
    const recording = createRecordingSql([
      [
        {
          id: "actor-1",
          org_id: "org-1",
          type: "user",
          email: "person@example.com",
          display_name: "Person",
          metadata,
        },
      ],
    ]);
    const store = new PostgresBetterAuthActorStore(recording.sql);

    const actor = await store.findUserActorByBetterAuthId("auth-user-1");

    expect(actor).toEqual({
      id: "actor-1",
      orgId: "org-1",
      type: "user",
      email: "person@example.com",
      displayName: "Person",
      scopes: [],
      metadata,
    });
    expect(recording.calls[0]?.text).toContain("metadata -> 'betterAuth' ->> 'userId'");
    expect(recording.calls[0]?.text).toContain("disabled_at is null");
    expect(recording.calls[0]?.values).toContain("auth-user-1");
  });

  it("finds active user actors by normalized email in an org", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "actor-1",
          org_id: "org-1",
          type: "user",
          email: "person@example.com",
          display_name: "Person",
          metadata: {},
        },
      ],
    ]);
    const store = new PostgresBetterAuthActorStore(recording.sql);

    const actor = await store.findUserActorByEmail("org-1", "PERSON@EXAMPLE.COM");

    expect(actor?.email).toBe("person@example.com");
    expect(recording.calls[0]?.text).toContain("lower(email)");
    expect(recording.calls[0]?.values).toContain("org-1");
    expect(recording.calls[0]?.values).toContain("person@example.com");
  });

  it("creates user actors in the actors table", async () => {
    const metadata = betterAuthMetadata("auth-user-1");
    const recording = createRecordingSql([
      [
        {
          actors_limit: 2,
          active_user_count: 1,
        },
      ],
      [
        {
          id: "actor-1",
          org_id: "org-1",
          type: "user",
          email: "person@example.com",
          display_name: "Person",
          metadata,
        },
      ],
    ]);
    const store = new PostgresBetterAuthActorStore(recording.sql);

    const actor = await store.createUserActor({
      orgId: "org-1",
      email: "person@example.com",
      displayName: "Person",
      metadata,
    });

    expect(actor.id).toBe("actor-1");
    expect(recording.calls[0]?.text).toContain("from orgs o");
    expect(recording.calls[0]?.text).toContain("left join plans p on p.id = o.plan_id");
    expect(recording.calls[0]?.text).toContain("o.quotas ? 'actors_limit'");
    expect(recording.calls[0]?.text).toContain("p.quotas_default ? 'actors_limit'");
    expect(recording.calls[0]?.text).toContain("a.disabled_at is null");
    expect(recording.calls[0]?.values).toEqual(["org-1", "org-1"]);
    expect(recording.calls[1]?.text).toContain("insert into actors");
    expect(recording.calls[1]?.text).toContain(
      "returning id, org_id, type, email, display_name, scopes, metadata",
    );
    expect(recording.calls[1]?.values).toEqual([
      "org-1",
      "user",
      "person@example.com",
      "Person",
      metadata,
    ]);
  });

  it("blocks new user actors when the tenant actors_limit is exhausted", async () => {
    const metadata = betterAuthMetadata("auth-user-1");
    const recording = createRecordingSql([
      [
        {
          actors_limit: 1,
          active_user_count: "1",
        },
      ],
    ]);
    const store = new PostgresBetterAuthActorStore(recording.sql);

    await expect(
      store.createUserActor({
        orgId: "org-1",
        email: "person@example.com",
        displayName: "Person",
        metadata,
      }),
    ).rejects.toThrow(ActorQuotaExceededError);

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).not.toContain("insert into actors");
  });

  it("treats JSON null actors_limit as unlimited", async () => {
    const metadata = betterAuthMetadata("auth-user-1");
    const recording = createRecordingSql([
      [
        {
          actors_limit: null,
          active_user_count: 100,
        },
      ],
      [
        {
          id: "actor-1",
          org_id: "org-1",
          type: "user",
          email: "person@example.com",
          display_name: "Person",
          metadata,
        },
      ],
    ]);
    const store = new PostgresBetterAuthActorStore(recording.sql);

    await expect(
      store.createUserActor({
        orgId: "org-1",
        email: "person@example.com",
        displayName: "Person",
        metadata,
      }),
    ).resolves.toMatchObject({ id: "actor-1" });
    expect(recording.calls[1]?.text).toContain("insert into actors");
  });

  it("links BetterAuth metadata onto existing active user actors", async () => {
    const metadata = betterAuthMetadata("auth-user-1");
    const recording = createRecordingSql([
      [
        {
          id: "actor-1",
          org_id: "org-1",
          type: "user",
          email: "person@example.com",
          display_name: "Person",
          metadata: { existing: true, ...metadata },
        },
      ],
    ]);
    const store = new PostgresBetterAuthActorStore(recording.sql);

    const actor = await store.linkBetterAuthUser({
      actorId: "actor-1",
      authUserId: "auth-user-1",
      metadata,
    });

    expect(actor.metadata).toEqual({ existing: true, ...metadata });
    expect(recording.calls[0]?.text).toContain("update actors");
    expect(recording.calls[0]?.text).toContain("metadata = metadata ||");
    expect(recording.calls[0]?.text).toContain("updated_at = now()");
    expect(recording.calls[0]?.values).toEqual([metadata, "actor-1"]);
  });

  it("persists BetterAuth user to actor links on the user table", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresBetterAuthUserLinkStore(recording.sql);

    await store.linkUserToActor({
      authUserId: "auth-user-1",
      actorId: "11111111-1111-4111-8111-111111111111",
    });

    expect(recording.calls[0]?.text).toContain('update "user"');
    expect(recording.calls[0]?.text).toContain("actor_id");
    expect(recording.calls[0]?.values).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "auth-user-1",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("issues BetterAuth-compatible database sessions with a signed helix cookie", async () => {
    const recording = createRecordingSql([[]]);
    const issuer = new PostgresBetterAuthSessionIssuer(recording.sql, {
      secret: "helix_local_better_auth_secret_change_me_32_chars",
      baseUrl: "https://app.helix.example",
      expiresInSeconds: 3600,
    });
    const now = new Date("2026-05-24T12:00:00.000Z");

    const issued = await issuer.issueSession({
      userId: "auth-user-1",
      requestHeaders: {
        "x-forwarded-for": "203.0.113.10, 10.0.0.1",
        "user-agent": "vitest",
      },
      now,
    });

    expect(recording.calls[0]?.text).toContain('insert into "session"');
    expect(recording.calls[0]?.values).toEqual([
      expect.stringMatching(/^session-/u),
      "auth-user-1",
      issued.token,
      issued.expiresAt,
      "203.0.113.10",
      "vitest",
      now,
      now,
    ]);
    expect(issued.cookieName).toBe("helix_session");
    expect(issued.expiresAt.toISOString()).toBe("2026-05-24T13:00:00.000Z");
    expect(issued.setCookieHeader).toContain(`helix_session=${issued.token}.`);
    expect(issued.setCookieHeader).toContain("HttpOnly");
    expect(issued.setCookieHeader).toContain("SameSite=Lax");
    expect(issued.setCookieHeader).toContain("Max-Age=3600");
    expect(issued.setCookieHeader).toContain("Secure");
  });

  it("resolves a BetterAuth session user into a linked platform actor", async () => {
    const actorStore = new InMemoryBetterAuthActorStore();
    const links: string[] = [];
    const module = createBetterAuthPlatformModule({
      actorStore,
      userLinkStore: {
        async linkUserToActor(input) {
          links.push(`${input.authUserId}:${input.actorId}`);
        },
      },
      defaultOrgId: "22222222-2222-4222-8222-222222222222",
    });
    const verifier: BetterAuthSessionVerifier = {
      async getSessionUser() {
        return {
          id: "auth-user-1",
          email: "Person@Example.com",
          name: "Person",
          emailVerified: true,
        };
      },
    };

    const actor = await createBetterAuthSessionActorResolver(module, verifier)({ headers: {} });

    expect(actor).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      type: "user",
      displayName: "Person",
      scopes: [],
      email: "person@example.com",
    });
    expect(links).toEqual(["auth-user-1:11111111-1111-4111-8111-111111111111"]);
  });

  it("uses a request tenant resolver when creating session actors", async () => {
    const actorStore = new InMemoryBetterAuthActorStore();
    const module = createBetterAuthPlatformModule({
      actorStore,
      defaultOrgId: "22222222-2222-4222-8222-222222222222",
    });
    const verifier: BetterAuthSessionVerifier = {
      async getSessionUser() {
        return {
          id: "auth-user-tenant",
          email: "tenant@example.com",
          name: "Tenant User",
        };
      },
    };

    const actor = await createBetterAuthSessionActorResolver(module, verifier, {
      resolveOrgId: () => "33333333-3333-4333-8333-333333333333",
    })({ headers: { host: "acme.helix.app" } });

    expect(actor?.orgId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("emits seat metering only when a new actor is created", async () => {
    const metering: RecordedMeteringEvent[] = [];
    const actorStore = new InMemoryBetterAuthActorStore();
    const module = createBetterAuthPlatformModule({
      actorStore,
      defaultOrgId: "22222222-2222-4222-8222-222222222222",
      metering: createRecordingMeteringClient(metering),
    });

    await module.resolveUserActor({
      id: "auth-user-created",
      email: "created@example.com",
      name: "Created User",
    });

    expect(metering).toEqual([
      {
        orgId: "22222222-2222-4222-8222-222222222222",
        event: {
          type: "seats.delta",
          quantity: 1,
          metadata: {
            source: "better_auth",
            reason: "user_created",
            actorId: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
    ]);
    expect(JSON.stringify(metering)).not.toContain("created@example.com");
    expect(JSON.stringify(metering)).not.toContain("Created User");
  });

  it("does not link an unverified email identity to an existing actor", async () => {
    const linkBetterAuthUser = vi.fn();
    const existing = {
      id: "actor-existing",
      orgId: "22222222-2222-4222-8222-222222222222",
      type: "user" as const,
      email: "victim@example.com",
      displayName: "Victim",
      scopes: ["admin.config.write"],
      metadata: {},
    };
    const module = createBetterAuthPlatformModule({
      actorStore: {
        async findUserActorByBetterAuthId() {
          return null;
        },
        async findUserActorByEmail() {
          return existing;
        },
        async createUserActor() {
          throw new Error("must not create when an existing email is found");
        },
        linkBetterAuthUser,
      },
      defaultOrgId: existing.orgId,
    });

    await expect(
      module.resolveUserActor({
        id: "unverified-auth-user",
        email: "victim@example.com",
        emailVerified: false,
      }),
    ).rejects.toBeInstanceOf(BetterAuthVerifiedEmailRequiredError);
    expect(linkBetterAuthUser).not.toHaveBeenCalled();
  });

  it("preserves verified-email linking to an existing actor", async () => {
    const existing = {
      id: "actor-existing",
      orgId: "22222222-2222-4222-8222-222222222222",
      type: "user" as const,
      email: "victim@example.com",
      displayName: "Victim",
      scopes: ["mail.read"],
      metadata: {},
    };
    const linkBetterAuthUser = vi.fn().mockResolvedValue({
      ...existing,
      metadata: { betterAuth: { userId: "verified-auth-user", emailVerified: true } },
    });
    const module = createBetterAuthPlatformModule({
      actorStore: {
        async findUserActorByBetterAuthId() {
          return null;
        },
        async findUserActorByEmail() {
          return existing;
        },
        async createUserActor() {
          throw new Error("must not create when an existing email is found");
        },
        linkBetterAuthUser,
      },
      defaultOrgId: existing.orgId,
    });

    await expect(
      module.resolveUserActor({
        id: "verified-auth-user",
        email: "victim@example.com",
        emailVerified: true,
      }),
    ).resolves.toMatchObject({ actor: { id: existing.id, scopes: ["mail.read"] } });
    expect(linkBetterAuthUser).toHaveBeenCalledTimes(1);
  });
});

describe("Better Auth browser cookie policy (ID.1 session cookie security matrix)", () => {
  it("enforces Secure, HttpOnly, and SameSite=Lax for an HTTPS production URL", () => {
    expect(sessionCookiePolicyForBaseUrl("https://app.helix.example")).toEqual({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("keeps local HTTP development possible without weakening the other attributes", () => {
    expect(sessionCookiePolicyForBaseUrl("http://localhost:3000")).toEqual({
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("documents the production cookie matrix required for browser sessions", () => {
    const matrix = {
      name: "helix_session",
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secureOnHttps: true,
      secureOnHttpLocal: false,
      notReadableFromJs: true,
    };
    const https = sessionCookiePolicyForBaseUrl("https://workspace.example");
    const httpLocal = sessionCookiePolicyForBaseUrl("http://127.0.0.1:5173");
    expect(https).toMatchObject({
      secure: matrix.secureOnHttps,
      httpOnly: matrix.httpOnly,
      sameSite: matrix.sameSite,
      path: matrix.path,
    });
    expect(httpLocal).toMatchObject({
      secure: matrix.secureOnHttpLocal,
      httpOnly: matrix.httpOnly,
      sameSite: matrix.sameSite,
      path: matrix.path,
    });
    // Helix never uses SameSite=None without Secure, and never drops HttpOnly.
    expect(https.sameSite).not.toBe("none");
    expect(https.httpOnly).toBe(true);
  });
});

function betterAuthMetadata(userId: string): JsonObject {
  return {
    betterAuth: {
      userId,
    },
  };
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => value,
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function createRecordingMeteringClient(events: RecordedMeteringEvent[]): MeteringClient {
  return {
    async emit(orgId, event, trace) {
      events.push({
        orgId,
        event,
        ...(trace === undefined ? {} : { trace }),
      });
    },
    async emitBatch(inputs) {
      for (const input of inputs) {
        events.push({
          orgId: input.orgId,
          event: input.event,
          ...(input.trace === undefined ? {} : { trace: input.trace }),
        });
      }
    },
  };
}

class InMemoryBetterAuthActorStore {
  async findUserActorByBetterAuthId() {
    return null;
  }

  async findUserActorByEmail() {
    return null;
  }

  async createUserActor(input: {
    readonly orgId: string;
    readonly email: string | null;
    readonly displayName: string;
    readonly metadata: JsonObject;
  }) {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: input.orgId,
      type: "user" as const,
      email: input.email,
      displayName: input.displayName,
      scopes: [] as readonly string[],
      metadata: input.metadata,
    };
  }

  async linkBetterAuthUser(input: {
    readonly actorId: string;
    readonly authUserId: string;
    readonly metadata: JsonObject;
  }) {
    return {
      id: input.actorId,
      orgId: "22222222-2222-4222-8222-222222222222",
      type: "user" as const,
      email: null,
      displayName: input.authUserId,
      scopes: [] as readonly string[],
      metadata: input.metadata,
    };
  }
}
