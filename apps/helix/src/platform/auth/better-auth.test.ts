import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createBetterAuthPlatformModule,
  createBetterAuthRuntime,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthSessionIssuer,
  PostgresBetterAuthSessionPolicyAuthorizer,
  type BetterAuthSessionVerifier,
} from "./better-auth.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("PostgresBetterAuthActorStore", () => {
  it("activates one provider link and tenant membership in a serializable transaction", async () => {
    const metadata = { existing: true };
    const recording = createRecordingSql([
      [{ email: "person@example.com" }],
      [{ actor_id: "actor-1" }],
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

    const actor = await store.resolveVerifiedUser({
      authUserId: "auth-user-1",
      orgId: "org-1",
      email: "person@example.com",
      displayName: "Person",
    });

    expect(actor).toEqual({
      id: "actor-1",
      orgId: "org-1",
      type: "user",
      email: "person@example.com",
      displayName: "Person",
      scopes: [],
      metadata,
    });
    expect(recording.beginOptions).toEqual(["isolation level serializable"]);
    expect(recording.calls[0]?.text).toContain("helix_canonical_login_email");
    expect(recording.calls[1]?.text).toContain("helix_activate_identity_membership");
    expect(recording.calls[1]?.values).toEqual([
      "auth-user-1",
      "org-1",
      "person@example.com",
      "Person",
    ]);
    expect(recording.calls[2]?.text).toContain("helix_credential_principal_is_active");
  });

  it("issues BetterAuth-compatible database sessions with a signed helix cookie", async () => {
    const recording = createRecordingSql([[]]);
    const issuer = new PostgresBetterAuthSessionIssuer(recording.sql, {
      secret: "helix_local_better_auth_secret_change_me_32_chars",
      secureCookies: true,
      expiresInSeconds: 3600,
    });
    const now = new Date("2026-05-24T12:00:00.000Z");

    const issued = await issuer.issueSession({
      userId: "auth-user-1",
      requestHeaders: {
        "x-forwarded-for": "198.51.100.99",
        "user-agent": "vitest",
      },
      ipAddress: "203.0.113.10",
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
    expect(issued.cookieName).toBe("__Secure-helix_session");
    expect(issued.expiresAt.toISOString()).toBe("2026-05-24T13:00:00.000Z");
    expect(issued.setCookieHeader).toContain(`__Secure-helix_session=${issued.token}.`);
    expect(issued.setCookieHeader).toContain("Path=/");
    expect(issued.setCookieHeader).toContain("HttpOnly");
    expect(issued.setCookieHeader).toContain("SameSite=Lax");
    expect(issued.setCookieHeader).toContain("Max-Age=3600");
    expect(issued.setCookieHeader).toContain("Secure");
  });

  it("passes only server-verified identity and tenant context to the database policy gate", async () => {
    const recording = createRecordingSql([[{ authorized: true }]]);
    const authorizer = new PostgresBetterAuthSessionPolicyAuthorizer(recording.sql);

    await expect(
      authorizer.authorize({
        token: "verified-token",
        authUserId: "auth-user-1",
        orgId: "22222222-2222-4222-8222-222222222222",
        actorId: "11111111-1111-4111-8111-111111111111",
        adminAction: true,
      }),
    ).resolves.toBe(true);
    expect(recording.calls[0]?.text).toContain("helix_authorize_tenant_session");
    expect(recording.calls[0]?.values).toEqual([
      "verified-token",
      "auth-user-1",
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      true,
    ]);
  });

  it("pins Better Auth cookie attributes independently of request transport", async () => {
    const runtime = createBetterAuthRuntime({
      databaseUrl: "postgres://helix:secret@localhost:5432/helix",
      secret: "a-production-strength-secret-with-32-characters",
      baseUrl: "https://app.helix.example",
      secureCookies: true,
    });

    try {
      const options = (
        runtime.auth as unknown as {
          readonly options: { readonly advanced?: Record<string, unknown> };
        }
      ).options;
      expect(options.advanced).toMatchObject({
        useSecureCookies: true,
        defaultCookieAttributes: {
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        },
      });
      expect(
        (
          runtime.auth as unknown as {
            readonly options: { readonly emailAndPassword?: Record<string, unknown> };
          }
        ).options.emailAndPassword,
      ).toMatchObject({
        enabled: true,
        disableSignUp: true,
        requireEmailVerification: true,
        resetPasswordTokenExpiresIn: 900,
        revokeSessionsOnPasswordReset: true,
      });
      expect(
        (
          runtime.auth as unknown as {
            readonly options: {
              readonly account?: Record<string, unknown>;
              readonly secrets?: readonly { readonly version: number; readonly value: string }[];
            };
          }
        ).options,
      ).toMatchObject({
        account: { encryptOAuthTokens: true },
        secrets: [{ version: 1, value: "a-production-strength-secret-with-32-characters" }],
        session: {
          expiresIn: 90 * 24 * 60 * 60,
          disableSessionRefresh: true,
        },
      });
      const sessionApi = runtime.auth.api as unknown as Record<string, unknown>;
      expect(typeof sessionApi.listSessions).toBe("function");
      expect(typeof sessionApi.revokeSession).toBe("function");
      expect(typeof sessionApi.revokeSessions).toBe("function");
      expect(typeof sessionApi.generatePasskeyRegistrationOptions).toBe("function");
      expect(typeof sessionApi.verifyPasskeyAuthentication).toBe("function");
      expect(typeof sessionApi.signInSSO).toBe("function");
      expect(typeof sessionApi.callbackSSO).toBe("function");
      expect(
        (
          runtime.auth as unknown as {
            readonly options: { readonly disabledPaths?: readonly string[] };
          }
        ).options.disabledPaths,
      ).toContain("/sso/register");
    } finally {
      await runtime.pool.end();
    }
  });

  it("resolves a BetterAuth session user into a linked platform actor", async () => {
    const actorStore = new InMemoryBetterAuthActorStore();
    const module = createBetterAuthPlatformModule({
      actorStore,
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
    expect(actorStore.resolutions).toEqual([
      {
        authUserId: "auth-user-1",
        orgId: "22222222-2222-4222-8222-222222222222",
        email: "person@example.com",
        displayName: "Person",
      },
    ]);
  });

  it("uses a request tenant resolver when linking pre-provisioned session actors", async () => {
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
          emailVerified: true,
        };
      },
    };

    const actor = await createBetterAuthSessionActorResolver(module, verifier, {
      resolveOrgId: () => "33333333-3333-4333-8333-333333333333",
    })({ headers: { host: "acme.helix.app" } });

    expect(actor?.orgId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("enforces the tenant session policy on the shared actor resolution path", async () => {
    const actorStore = new InMemoryBetterAuthActorStore();
    const module = createBetterAuthPlatformModule({
      actorStore,
      defaultOrgId: "22222222-2222-4222-8222-222222222222",
    });
    const authorizations: unknown[] = [];
    const verifier: BetterAuthSessionVerifier = {
      async getSessionUser() {
        return {
          id: "auth-user-tenant",
          email: "tenant@example.com",
          name: "Tenant User",
          emailVerified: true,
        };
      },
      async getSessionToken() {
        return "server-verified-token";
      },
    };
    const resolver = createBetterAuthSessionActorResolver(module, verifier, {
      policyAuthorizer: {
        async authorize(input) {
          authorizations.push(input);
          return false;
        },
      },
    });

    await expect(
      resolver({ headers: {}, method: "PUT", url: "/api/admin/security-policies/session" }),
    ).resolves.toBeNull();
    expect(authorizations).toEqual([
      {
        token: "server-verified-token",
        authUserId: "auth-user-tenant",
        orgId: "22222222-2222-4222-8222-222222222222",
        actorId: "11111111-1111-4111-8111-111111111111",
        adminAction: true,
      },
    ]);
  });

  it("rejects unverified and unknown users without creating a platform actor", async () => {
    const actorStore = new InMemoryBetterAuthActorStore(false);
    const module = createBetterAuthPlatformModule({
      actorStore,
      defaultOrgId: "22222222-2222-4222-8222-222222222222",
    });

    await expect(
      module.resolveUserActor({ id: "unverified", email: "victim@example.com" }),
    ).resolves.toBeNull();
    await expect(
      module.resolveUserActor({
        id: "verified-but-not-enrolled",
        email: "victim@example.com",
        emailVerified: true,
      }),
    ).resolves.toBeNull();
    expect(actorStore.resolutions).toHaveLength(1);
  });
});

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly beginOptions: readonly string[];
} {
  const calls: RecordedQuery[] = [];
  const beginOptions: string[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => value,
    json: (value: unknown) => value,
    begin: async <T>(
      options: string | ((tx: postgres.TransactionSql) => T | Promise<T>),
      callback?: (tx: postgres.TransactionSql) => T | Promise<T>,
    ) => {
      if (typeof options === "string") beginOptions.push(options);
      const execute = typeof options === "function" ? options : callback;
      if (execute === undefined) throw new Error("Missing transaction callback.");
      return execute(sql as unknown as postgres.TransactionSql);
    },
  }) as unknown as postgres.Sql;
  return { sql, calls, beginOptions };
}

class InMemoryBetterAuthActorStore {
  readonly resolutions: Array<{
    readonly authUserId: string;
    readonly orgId: string;
    readonly email: string;
    readonly displayName: string;
  }> = [];

  constructor(private readonly enrolled = true) {}

  async resolveVerifiedUser(input: {
    readonly authUserId: string;
    readonly orgId: string;
    readonly email: string;
    readonly displayName: string;
  }) {
    this.resolutions.push(input);
    if (!this.enrolled) {
      return null;
    }
    return {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: input.orgId,
      type: "user" as const,
      email: input.email,
      displayName: input.displayName,
      scopes: [] as readonly string[],
      metadata: {},
    };
  }
}
