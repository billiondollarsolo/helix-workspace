import {
  accountPasswordChangeInputSchema,
  accountSessionRevokeParamsSchema,
  type AccountSession,
} from "@helix/contracts";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionActorResolver } from "../../api/actor.js";
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../api/api-error.js";
import { auditAdminAction, type AdminConsoleAuditSink } from "../admin/console-shared.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { setTenantPostgresActorId } from "../tenancy/postgres-roles.js";
import { isRecord } from "../util/json.js";
import type { BetterAuthInstance, BetterAuthSessionVerifier } from "./better-auth.js";
import { createBetterAuthRequest } from "./better-auth-request.js";

interface BetterAuthSessionRow {
  readonly id: string;
  readonly token: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Self-service account security for the signed-in person: change the password
 * through Better Auth (current password required, other sessions optionally
 * signed out), and list or sign out their own sessions. Session tokens never
 * leave the server; sessions are addressed by id.
 */
export function registerAccountSecurityRoutes(
  app: FastifyInstance,
  options: {
    readonly auth: Pick<BetterAuthInstance, "handler">;
    readonly sessionVerifier: Pick<BetterAuthSessionVerifier, "getSessionToken">;
    readonly sessionActorResolver: SessionActorResolver | undefined;
    readonly auditSink: AdminConsoleAuditSink;
  },
): void {
  const person = async (request: FastifyRequest): Promise<Actor> => {
    const actor = await options.sessionActorResolver?.resolve(request);
    if (actor == null || actor.id === "anonymous") {
      throw new UnauthorizedError("Sign in to manage your account security.");
    }
    assertActorMatchesRequestTenant(request, actor);
    if (actor.type !== "user") {
      throw new ForbiddenError("Account security is available to people signed in to the web app.");
    }
    await setTenantPostgresActorId(actor.id);
    return actor;
  };
  const callAuth = (
    request: FastifyRequest,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) =>
    options.auth.handler(
      createBetterAuthRequest(request, { method, path: `/api/auth/${path}`, body }),
    );
  const sessions = async (request: FastifyRequest): Promise<readonly BetterAuthSessionRow[]> => {
    const response = await callAuth(request, "GET", "list-sessions");
    const payload: unknown = response.ok ? await response.json() : null;
    if (!Array.isArray(payload)) throw new UnauthorizedError("Sign in again to manage sessions.");
    return payload.filter(isSessionRow);
  };
  const audit = (actor: Actor, verb: string, metadata: Record<string, unknown>) =>
    auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb,
      objectType: "actor",
      objectId: actor.id,
      metadata,
    });

  app.get("/api/account/sessions", async (request) => {
    await person(request);
    const current = await options.sessionVerifier.getSessionToken?.({ headers: request.headers });
    const listed = await sessions(request);
    return {
      sessions: listed
        .map((session) => describeSession(session, session.token === current))
        .sort(
          (left, right) =>
            Number(right.current) - Number(left.current) ||
            right.lastActiveAt.localeCompare(left.lastActiveAt),
        ),
    };
  });

  app.post("/api/account/sessions/:sessionId/revoke", async (request) => {
    const actor = await person(request);
    const parsed = accountSessionRevokeParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new BadRequestError("Choose a session to sign out.");
    const current = await options.sessionVerifier.getSessionToken?.({ headers: request.headers });
    const session = (await sessions(request)).find((row) => row.id === parsed.data.sessionId);
    if (session === undefined) throw new NotFoundError("That session has already ended.");
    if (session.token === current) {
      throw new BadRequestError("Use Sign out to end the session you are using now.");
    }
    const response = await callAuth(request, "POST", "revoke-session", { token: session.token });
    if (!response.ok) throw new ApiError("internal_error", "The session could not be signed out.");
    await audit(actor, "account.session.revoked", { sessionId: session.id });
    return { revoked: true };
  });

  app.post("/api/account/sessions/revoke-others", async (request) => {
    const actor = await person(request);
    const others = (await sessions(request)).length - 1;
    const response = await callAuth(request, "POST", "revoke-other-sessions", {});
    if (!response.ok)
      throw new ApiError("internal_error", "Other sessions could not be signed out.");
    await audit(actor, "account.sessions.revoked_others", { revoked: Math.max(others, 0) });
    return { revoked: Math.max(others, 0) };
  });

  app.post("/api/account/password", async (request, reply) => {
    const actor = await person(request);
    const parsed = accountPasswordChangeInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(
        "Enter your current password and a new password of 8 to 128 characters.",
        {
          details: parsed.error.issues,
        },
      );
    }
    const response = await callAuth(request, "POST", "change-password", parsed.data);
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "";
      if (code === "INVALID_PASSWORD")
        throw new BadRequestError("Your current password is incorrect.");
      if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG")
        throw new BadRequestError("Choose a new password of 8 to 128 characters.");
      if (code === "CREDENTIAL_ACCOUNT_NOT_FOUND")
        throw new BadRequestError(
          "This account signs in with single sign-on or a passkey and has no password to change.",
        );
      throw new ApiError("internal_error", "Your password could not be changed. Try again.");
    }
    forwardSessionCookie(response, reply);
    await audit(actor, "account.password.changed", {
      revokedOtherSessions: parsed.data.revokeOtherSessions,
    });
    return { changed: true, revokedOtherSessions: parsed.data.revokeOtherSessions };
  });
}

/** Signing other sessions out rotates the current session; keep the browser signed in. */
function forwardSessionCookie(response: Response, reply: FastifyReply): void {
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
}

function isSessionRow(value: unknown): value is BetterAuthSessionRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.token === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.expiresAt === "string"
  );
}

function describeSession(session: BetterAuthSessionRow, current: boolean): AccountSession {
  const userAgent = session.userAgent ?? null;
  const device = describeUserAgent(userAgent ?? "");
  return {
    id: session.id,
    current,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActiveAt: new Date(session.updatedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    ipAddress: session.ipAddress ?? null,
    userAgent,
    browser: device.browser,
    os: device.os,
    deviceType: device.deviceType,
  };
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//u, "Edge"],
  [/\bOPR\//u, "Opera"],
  [/\bFirefox\/|\bFxiOS\//u, "Firefox"],
  [/\bChrome\/|\bCriOS\//u, "Chrome"],
  [/\bSafari\//u, "Safari"],
  [/\bcurl\//u, "Command line"],
  [/^helix-cli\b/u, "Helix CLI"],
];
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:iPhone|iPad|iPod)\b/u, "iOS"],
  [/\bAndroid\b/u, "Android"],
  [/\bWindows\b/u, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/u, "macOS"],
  [/\bCrOS\b/u, "ChromeOS"],
  [/\bLinux\b/u, "Linux"],
];

/** A readable device summary; unknown agents read as "Unknown". */
export function describeUserAgent(userAgent: string): {
  readonly browser: string;
  readonly os: string;
  readonly deviceType: AccountSession["deviceType"];
} {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Unknown";
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Unknown";
  const deviceType = /\b(?:iPad|Tablet)\b/u.test(userAgent)
    ? "tablet"
    : /\b(?:Mobile|iPhone|Android)\b/u.test(userAgent)
      ? "mobile"
      : browser === "Unknown" && os === "Unknown"
        ? "unknown"
        : "desktop";
  return { browser, os, deviceType };
}
