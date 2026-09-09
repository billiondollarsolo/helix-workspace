import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { sso, type SSOUserResolutionInput } from "@better-auth/sso";
import { makeSignature } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import { twoFactor } from "better-auth/plugins";
import type postgres from "postgres";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Actor, JsonObject } from "@helix/sdk";
import { validatedPermissions } from "../permissions/scope-catalog.js";
import { parseActorRoleBindings } from "../permissions/roles.js";

export interface BetterAuthInstance {
  readonly api: {
    getSession(input: { readonly headers: Headers }): Promise<unknown>;
  };
  handler(request: Request): Promise<Response>;
}

export interface BetterAuthUser {
  readonly id: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly image?: string | null;
  readonly emailVerified?: boolean;
  readonly createdAt?: Date | string;
  readonly updatedAt?: Date | string;
}

export interface ActorUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly type: "user";
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly roleBindings?: Actor["roleBindings"];
  readonly metadata: JsonObject;
}

export interface BetterAuthActorStore {
  resolveVerifiedUser(input: {
    readonly authUserId: string;
    readonly orgId: string;
    readonly email: string;
    readonly displayName: string;
  }): Promise<ActorUserRecord | null>;
}

export interface BetterAuthPlatformModuleOptions {
  readonly actorStore: BetterAuthActorStore;
  readonly defaultOrgId: string;
}

export interface BetterAuthActorResolution {
  readonly actor: Actor;
  readonly user: BetterAuthUser;
}

export class BetterAuthPlatformModule {
  constructor(private readonly options: BetterAuthPlatformModuleOptions) {}

  async resolveUserActor(
    user: BetterAuthUser,
    orgId = this.options.defaultOrgId,
  ): Promise<BetterAuthActorResolution | null> {
    if (user.emailVerified !== true) {
      return null;
    }
    const email = normalizeEmail(user.email);
    if (email === null) {
      return null;
    }
    const actor = await this.options.actorStore.resolveVerifiedUser({
      authUserId: user.id,
      orgId,
      email,
      displayName: user.name?.trim() || email,
    });
    return actor === null ? null : { actor: toActor(actor), user };
  }
}

interface ActorUserRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: "user";
  readonly email: string | null;
  readonly display_name: string;
  readonly scopes: readonly string[] | null;
  readonly role_bindings: unknown;
  readonly metadata: JsonObject;
}

export class PostgresBetterAuthActorStore implements BetterAuthActorStore {
  constructor(private readonly sql: postgres.Sql) {}

  async resolveVerifiedUser(input: {
    readonly authUserId: string;
    readonly orgId: string;
    readonly email: string;
    readonly displayName: string;
  }): Promise<ActorUserRecord | null> {
    return this.resolveSerializable(input, 2);
  }

  private async resolveSerializable(
    input: {
      readonly authUserId: string;
      readonly orgId: string;
      readonly email: string;
      readonly displayName: string;
    },
    retries: number,
  ): Promise<ActorUserRecord | null> {
    try {
      return await this.sql.begin("isolation level serializable", async (tx) => {
        const canonical = await tx<{ readonly email: string | null }[]>`
          select helix_canonical_login_email(${input.orgId}, ${input.email}) as email
        `;
        const email = canonical[0]?.email;
        if (email === null || email === undefined) {
          return null;
        }
        const activated = await tx<{ readonly actor_id: string | null }[]>`
          select helix_activate_identity_membership(
            'better-auth',
            ${input.authUserId},
            ${input.orgId},
            ${email},
            ${input.displayName}
          ) as actor_id
        `;
        const actorId = activated[0]?.actor_id;
        if (actorId === null || actorId === undefined) {
          return null;
        }
        const rows = await tx<ActorUserRow[]>`
          select id, org_id, type, email, display_name, scopes, metadata,
            helix_actor_role_bindings(org_id, id) as role_bindings
          from actors
          where id = ${actorId}
            and org_id = ${input.orgId}
            and type = 'user'
            and disabled_at is null
            and helix_credential_principal_is_active(id, org_id)
          limit 1
        `;
        return rowToActorUser(rows[0]);
      });
    } catch (error) {
      if (retries > 0 && postgresErrorCode(error) === "40001") {
        return this.resolveSerializable(input, retries - 1);
      }
      throw error;
    }
  }
}

export interface BetterAuthSessionIssueInput {
  readonly userId: string;
  readonly requestHeaders?: IncomingHttpHeaders;
  readonly ipAddress?: string;
  readonly now?: Date;
}

export interface BetterAuthSessionIssueResult {
  readonly token: string;
  readonly expiresAt: Date;
  readonly cookieName: string;
  readonly setCookieHeader: string;
}

export interface BetterAuthSessionIssuer {
  issueSession(input: BetterAuthSessionIssueInput): Promise<BetterAuthSessionIssueResult>;
}

export class PostgresBetterAuthSessionIssuer implements BetterAuthSessionIssuer {
  private readonly secret: string;
  private readonly cookieName: string;
  private readonly secureCookies: boolean;
  private readonly expiresInSeconds: number;

  constructor(
    private readonly sql: postgres.Sql,
    options: {
      readonly secret: string;
      readonly secureCookies: boolean;
      readonly cookieName?: string;
      readonly expiresInSeconds?: number;
    },
  ) {
    this.secret = options.secret;
    this.secureCookies = options.secureCookies;
    this.cookieName =
      options.cookieName ?? `${options.secureCookies ? "__Secure-" : ""}helix_session`;
    this.expiresInSeconds = options.expiresInSeconds ?? 90 * 24 * 60 * 60;
  }

  async issueSession(input: BetterAuthSessionIssueInput): Promise<BetterAuthSessionIssueResult> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + this.expiresInSeconds * 1000);
    const token = randomBytes(32).toString("base64url");
    await this.sql`
      insert into "session" (
        id,
        "userId",
        token,
        "expiresAt",
        "ipAddress",
        "userAgent",
        "createdAt",
        "updatedAt"
      )
      values (
        ${`session-${randomBytes(16).toString("base64url")}`},
        ${input.userId},
        ${token},
        ${expiresAt},
        ${input.ipAddress ?? ""},
        ${headerValue(input.requestHeaders?.["user-agent"])},
        ${now},
        ${now}
      )
    `;
    const signedToken = `${token}.${await makeSignature(token, this.secret)}`;
    return {
      token,
      expiresAt,
      cookieName: this.cookieName,
      setCookieHeader: serializeSessionCookie({
        name: this.cookieName,
        value: signedToken,
        maxAge: this.expiresInSeconds,
        expiresAt,
        secure: this.secureCookies,
      }),
    };
  }
}

export interface BetterAuthSessionVerifier {
  getSessionUser(request: {
    readonly headers: IncomingHttpHeaders;
  }): Promise<BetterAuthUser | null>;
  /** Raw server-side session token; never sourced directly from a request field. */
  getSessionToken?(request: { readonly headers: IncomingHttpHeaders }): Promise<string | null>;
}

export interface BetterAuthSessionActorResolverOptions {
  readonly resolveOrgId?: (request: {
    readonly headers: IncomingHttpHeaders;
    readonly method?: string;
    readonly url?: string;
  }) => Promise<string> | string;
  readonly policyAuthorizer?: BetterAuthSessionPolicyAuthorizer;
}

export interface BetterAuthSessionPolicyAuthorizer {
  authorize(input: {
    readonly token: string;
    readonly authUserId: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly adminAction: boolean;
  }): Promise<boolean>;
}

export class PostgresBetterAuthSessionPolicyAuthorizer implements BetterAuthSessionPolicyAuthorizer {
  constructor(private readonly sql: postgres.Sql) {}

  async authorize(input: {
    readonly token: string;
    readonly authUserId: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly adminAction: boolean;
  }): Promise<boolean> {
    const rows = await this.sql<{ readonly authorized: boolean }[]>`
      select helix_authorize_tenant_session(
        ${input.token},
        ${input.authUserId},
        ${input.orgId},
        ${input.actorId},
        ${input.adminAction}
      ) as authorized
    `;
    return rows[0]?.authorized === true;
  }
}

export class BetterAuthApiSessionVerifier implements BetterAuthSessionVerifier {
  constructor(private readonly auth: Pick<BetterAuthInstance, "api">) {}

  async getSessionUser(request: {
    readonly headers: IncomingHttpHeaders;
  }): Promise<BetterAuthUser | null> {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    return betterAuthUserFromSession(session);
  }

  async getSessionToken(request: {
    readonly headers: IncomingHttpHeaders;
  }): Promise<string | null> {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!isRecord(session) || !isRecord(session.session)) {
      return null;
    }
    return typeof session.session.token === "string" ? session.session.token : null;
  }
}

export interface BetterAuthRuntimeConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly secureCookies: boolean;
  readonly trustedOrigins?: readonly string[];
  readonly sendPasswordReset?: (input: {
    readonly email: string;
    readonly url: string;
    readonly token: string;
  }) => Promise<void>;
  readonly resolveSsoUser?: (
    input: SSOUserResolutionInput,
  ) => Promise<
    | { readonly action: "link"; readonly userId: string; readonly profile: "preserve" }
    | { readonly action: "reject"; readonly code: string; readonly message: string }
  >;
  readonly resolveSsoPrivateKey?: (input: {
    readonly providerId: string;
    readonly keyId?: string;
    readonly issuer: string;
  }) => Promise<{ readonly privateKeyPem: string; readonly kid?: string; readonly algorithm?: string }>;
}

export interface BetterAuthRuntime {
  readonly auth: BetterAuthInstance;
  readonly pool: Pool;
  readonly sessionVerifier: BetterAuthSessionVerifier;
}

export function createBetterAuthRuntime(config: BetterAuthRuntimeConfig): BetterAuthRuntime {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const sendPasswordReset = config.sendPasswordReset;
  const auth = betterAuth({
    database: pool,
    secrets: [{ version: 1, value: config.secret }],
    baseURL: config.baseUrl,
    trustedOrigins: async (request) => {
      const applicationOrigins = [config.baseUrl, ...(config.trustedOrigins ?? [])];
      if (request === undefined || !new URL(request.url).pathname.includes("/sso")) {
        return applicationOrigins;
      }
      const result = await pool.query<{ issuer: string; oidcConfig: string }>(
        'select issuer, "oidcConfig" from "ssoProvider" where "domainVerified"',
      );
      return [
        ...applicationOrigins,
        ...result.rows.flatMap((row) => oidcTrustedOrigins(row.issuer, row.oidcConfig)),
      ];
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 15 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(sendPasswordReset === undefined
        ? {}
        : {
            sendResetPassword: ({ user, url, token }: {
              user: { email: string };
              url: string;
              token: string;
            }) => sendPasswordReset({ email: user.email, url, token }),
          }),
    },
    session: {
      expiresIn: 90 * 24 * 60 * 60,
      disableSessionRefresh: true,
    },
    account: { encryptOAuthTokens: true },
    disabledPaths: [
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/providers",
      "/sso/get-provider",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
    ],
    plugins: [
      twoFactor({
        issuer: "Helix",
        twoFactorCookieMaxAge: 600,
        trustDeviceMaxAge: 0,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
      passkey({
        rpID: new URL(config.baseUrl).hostname,
        rpName: "Helix",
        origin: config.baseUrl,
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        authentication: {
          afterVerification({ verification }) {
            if (!verification.authenticationInfo.userVerified) {
              throw new Error("Passkey user verification is required.");
            }
          },
        },
      }),
      sso({
        providersLimit: 0,
        disableImplicitSignUp: true,
        organizationProvisioning: { disabled: true },
        domainVerification: { enabled: true, tokenPrefix: "helix-sso" },
        resolveUser:
          config.resolveSsoUser ??
          (() =>
            Promise.resolve({
              action: "reject",
              code: "SSO_RESOLVER_UNAVAILABLE",
              message: "SSO sign-in is unavailable.",
            })),
        resolvePrivateKey: async (input) => {
          if (config.resolveSsoPrivateKey === undefined) {
            throw new Error("OIDC signing key resolver is unavailable.");
          }
          return config.resolveSsoPrivateKey(input);
        },
        saml: {
          enableInResponseToValidation: true,
          allowIdpInitiated: false,
          requireTimestamps: true,
          algorithms: { onDeprecated: "reject" },
        },
      }),
    ],
    advanced: {
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: {
        secure: config.secureCookies,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      cookiePrefix: "helix",
      cookies: {
        session_token: {
          name: "helix_session",
        },
      },
    },
  });
  return {
    auth,
    pool,
    sessionVerifier: new BetterAuthApiSessionVerifier(auth),
  };
}

function oidcTrustedOrigins(issuer: string, serializedConfig: string): string[] {
  const candidates: unknown[] = [issuer];
  try {
    const config = JSON.parse(serializedConfig) as Record<string, unknown>;
    candidates.push(
      config.discoveryEndpoint,
      config.authorizationEndpoint,
      config.tokenEndpoint,
      config.jwksEndpoint,
      config.userInfoEndpoint,
    );
  } catch {
    return [];
  }
  return [
    ...new Set(
      candidates.flatMap((candidate) => {
        if (typeof candidate !== "string") return [];
        try {
          const url = new URL(candidate);
          return url.protocol === "https:" ? [url.origin] : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

export function createBetterAuthSessionActorResolver(
  module: BetterAuthPlatformModule,
  verifier: BetterAuthSessionVerifier,
  options: BetterAuthSessionActorResolverOptions = {},
): (request: {
  readonly headers: IncomingHttpHeaders;
  readonly method?: string;
  readonly url?: string;
}) => Promise<Actor | null> {
  return async (request) => {
    const user = await verifier.getSessionUser(request);
    if (user === null) {
      return null;
    }
    const orgId = await options.resolveOrgId?.(request);
    const resolved = await module.resolveUserActor(user, orgId);
    if (resolved === null) {
      return null;
    }
    if (options.policyAuthorizer !== undefined) {
      const token = await verifier.getSessionToken?.(request);
      if (
        token === null ||
        token === undefined ||
        !(await options.policyAuthorizer.authorize({
          token,
          authUserId: user.id,
          orgId: resolved.actor.orgId,
          actorId: resolved.actor.id,
          adminAction: isAdminSessionRequest(request),
        }))
      ) {
        return null;
      }
    }
    return resolved.actor;
  };
}

export function createBetterAuthPlatformModule(
  options: BetterAuthPlatformModuleOptions,
): BetterAuthPlatformModule {
  return new BetterAuthPlatformModule(options);
}

function rowToActorUser(row: ActorUserRow | undefined): ActorUserRecord | null {
  if (row === undefined) {
    return null;
  }
  const roleBindings = parseActorRoleBindings(row.role_bindings);
  return {
    id: row.id,
    orgId: row.org_id,
    type: row.type,
    email: row.email,
    displayName: row.display_name,
    scopes: row.scopes ?? [],
    ...(roleBindings.length === 0 ? {} : { roleBindings }),
    metadata: row.metadata,
  };
}

function toActor(record: ActorUserRecord): Actor {
  return {
    id: record.id,
    orgId: record.orgId,
    type: "user",
    displayName: record.displayName,
    // Carry the actor's scopes so session-authenticated requests are
    // authorized identically to bearer-token (OAuth) requests.
    scopes: validatedPermissions(record.scopes),
    ...(record.roleBindings === undefined ? {} : { roleBindings: record.roleBindings }),
    ...(record.email === null ? {} : { email: record.email }),
  };
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

function isAdminSessionRequest(request: {
  readonly method?: string;
  readonly url?: string;
}): boolean {
  const path = request.url?.split("?", 1)[0] ?? "";
  return (
    path === "/api/admin" ||
    path.startsWith("/api/admin/") ||
    path === "/trpc/admin" ||
    path.startsWith("/trpc/admin.")
  );
}

function serializeSessionCookie(input: {
  readonly name: string;
  readonly value: string;
  readonly maxAge: number;
  readonly expiresAt: Date;
  readonly secure: boolean;
}): string {
  return [
    `${input.name}=${input.value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(input.maxAge)}`,
    `Expires=${input.expiresAt.toUTCString()}`,
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");
}

function headerValue(value: string | readonly string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === "string" ? first : null;
  }
  return typeof value === "string" ? value : null;
}

function betterAuthUserFromSession(session: unknown): BetterAuthUser | null {
  if (!isRecord(session) || !isRecord(session.user) || typeof session.user.id !== "string") {
    return null;
  }
  return {
    id: session.user.id,
    ...(typeof session.user.email === "string" ? { email: session.user.email } : {}),
    ...(typeof session.user.name === "string" ? { name: session.user.name } : {}),
    ...(typeof session.user.image === "string" ? { image: session.user.image } : {}),
    ...(typeof session.user.emailVerified === "boolean"
      ? { emailVerified: session.user.emailVerified }
      : {}),
    ...(session.user.createdAt instanceof Date || typeof session.user.createdAt === "string"
      ? { createdAt: session.user.createdAt }
      : {}),
    ...(session.user.updatedAt instanceof Date || typeof session.user.updatedAt === "string"
      ? { updatedAt: session.user.updatedAt }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function postgresErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}
