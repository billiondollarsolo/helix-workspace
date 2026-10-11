import type { Actor } from "@helix/sdk-types";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import { parseBasicAuthorization } from "../util/http-auth.js";
import type { WebDavRateLimiter } from "./webdav-security.js";

const WINDOW_MS = 60_000;
/** Failed credential attempts per client IP per minute (brute-force guard). */
export const WEBDAV_AUTH_FAILURE_LIMIT = 20;
/** Authenticated requests per actor per minute; sized for a first desktop sync. */
export const WEBDAV_ACTOR_REQUEST_LIMIT = 600;
/** Authenticated mutations per actor per minute. */
const WEBDAV_MUTATION_LIMIT = 120;

const WEBDAV_DRIVE_SCOPES = ["drive.read", "drive.write", "drive.delete"] as const;
export type WebDavDriveScope = (typeof WEBDAV_DRIVE_SCOPES)[number];

export type WebDavAccessDecision =
  | { readonly ok: true; readonly actor: Actor }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 429;
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

export interface WebDavAccessInput {
  readonly authorization: string | undefined;
  readonly ip: string;
  readonly requiredScope: WebDavDriveScope;
  readonly mutation: boolean;
  readonly authenticator: AppPasswordAuthenticator;
  readonly rateLimiter: WebDavRateLimiter;
}

const credentialsRequired = "WebDAV app password required.";

/**
 * Authenticates a WebDAV request and applies rate limits.
 *
 * The per-IP bucket is only charged when presented credentials fail, so many
 * users behind one proxy can sync at once while brute force stays bounded.
 * Authenticated traffic is charged to a per-actor bucket instead.
 */
export async function authorizeWebDavAccess(
  input: WebDavAccessInput,
): Promise<WebDavAccessDecision> {
  const credentials = parseBasicAuthorization(input.authorization);
  if (credentials === null) {
    return { ok: false, status: 401, message: credentialsRequired };
  }
  const ipKey = `auth:${input.ip}`;
  const ipBudget = input.rateLimiter.peek(ipKey, WEBDAV_AUTH_FAILURE_LIMIT, WINDOW_MS);
  if (!ipBudget.allowed) {
    return rateLimited("WebDAV authentication rate limit exceeded.", ipBudget.retryAfterSeconds);
  }
  const authenticate = (requiredScope: string) =>
    input.authenticator.authenticateAppPassword({
      username: credentials.username,
      password: credentials.password,
      requiredScope,
      compatibilityScope: "webdav",
    });

  const actor = await authenticate(input.requiredScope);
  if (actor === null) {
    const validActor = await validCredentialsWithoutScope(authenticate, input.requiredScope);
    if (validActor === null) {
      input.rateLimiter.consume(ipKey, WEBDAV_AUTH_FAILURE_LIMIT, WINDOW_MS);
      return { ok: false, status: 401, message: credentialsRequired };
    }
    const actorBudget = consumeActor(input.rateLimiter, "request", validActor);
    if (!actorBudget.allowed) {
      return rateLimited("WebDAV request rate limit exceeded.", actorBudget.retryAfterSeconds);
    }
    return {
      ok: false,
      status: 403,
      message:
        `This app password is missing the "${input.requiredScope}" scope. ` +
        'Ask your Helix admin for an app password with the "Desktop sync (WebDAV)" preset.',
    };
  }

  const requestBudget = consumeActor(input.rateLimiter, "request", actor);
  if (!requestBudget.allowed) {
    return rateLimited("WebDAV request rate limit exceeded.", requestBudget.retryAfterSeconds);
  }
  if (input.mutation) {
    const mutationBudget = consumeActor(input.rateLimiter, "mutation", actor);
    if (!mutationBudget.allowed) {
      return rateLimited("WebDAV mutation rate limit exceeded.", mutationBudget.retryAfterSeconds);
    }
  }
  return { ok: true, actor };
}

async function validCredentialsWithoutScope(
  authenticate: (scope: string) => Promise<Actor | null>,
  missingScope: WebDavDriveScope,
): Promise<Actor | null> {
  for (const scope of WEBDAV_DRIVE_SCOPES) {
    if (scope === missingScope) continue;
    const actor = await authenticate(scope);
    if (actor !== null) return actor;
  }
  return null;
}

function consumeActor(limiter: WebDavRateLimiter, bucket: "request" | "mutation", actor: Actor) {
  const limit = bucket === "request" ? WEBDAV_ACTOR_REQUEST_LIMIT : WEBDAV_MUTATION_LIMIT;
  return limiter.consume(`${bucket}:${actor.orgId}:${actor.id}`, limit, WINDOW_MS);
}

function rateLimited(message: string, retryAfterSeconds: number): WebDavAccessDecision {
  return { ok: false, status: 429, message, retryAfterSeconds };
}
