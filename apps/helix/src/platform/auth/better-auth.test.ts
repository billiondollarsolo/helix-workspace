import type { JsonObject } from "@helix/sdk";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createBetterAuthPlatformModule,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthUserLinkStore,
  type BetterAuthSessionVerifier,
} from "./better-auth.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
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
    expect(recording.calls[0]?.text).toContain("insert into actors");
    expect(recording.calls[0]?.text).toContain("returning id, org_id, type, email, display_name, metadata");
    expect(recording.calls[0]?.values).toEqual([
      "org-1",
      "user",
      "person@example.com",
      "Person",
      metadata,
    ]);
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
      email: "person@example.com",
    });
    expect(links).toEqual(["auth-user-1:11111111-1111-4111-8111-111111111111"]);
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
      metadata: input.metadata,
    };
  }
}
