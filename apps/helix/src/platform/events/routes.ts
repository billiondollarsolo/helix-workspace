import type { Actor, EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import { unauthenticatedActor } from "../../api/actor.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";
import type { EventStreamLimiter } from "./stream-limit.js";

interface EventSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RegisterEventRoutesOptions {
  readonly bus?: EventBus | undefined;
  /**
   * Per-org ceiling on concurrent streams. `/events/ws` is exempt from the
   * tenant request-rate meter (a rate limit is the wrong control for a
   * connection that lives for minutes), so this is what bounds the resource.
   * Omit only in tests that are not exercising the cap.
   */
  readonly streamLimiter?: EventStreamLimiter | undefined;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * Records active WebSocket connections for the
   * `helix_websocket_connections_active` gauge (Follow-up B).
   */
  readonly metrics?: WebsocketConnectionMetrics | undefined;
}

/** Route label for the events WebSocket connection gauge. */
const EVENTS_WS_ROUTE = "/events/ws";

/**
 * Subjects that are allowed to reach a subscriber even though their payload
 * names no org.
 *
 * This list exists because a genuinely platform-global event and an org-scoped
 * event whose publisher forgot to stamp an `orgId` are indistinguishable once
 * they reach this socket — both are just a payload with no org marker. Guessing
 * "probably global" would reopen the exact leak this guard closes, so the
 * default is to drop, and a subject only earns delivery by being named here
 * after someone confirms it can never carry tenant data.
 *
 * `signup.form_viewed` qualifies: it is emitted from the public signup form
 * before any org exists (its schema is declared `tenantScoped: false` in
 * platform/signup/event-schemas.ts), so there is no tenant whose data it could
 * expose.
 *
 * `helix.config.changed` qualifies for a different reason: it is not org-scoped
 * at all. `PlatformConfigService.update` (platform/config/admin.ts) mutates
 * deployment-wide configuration — the security tier, AI governance — and there
 * is no org in scope at the publish site. Stamping `actor.orgId` on it would
 * pin a platform-global event to whichever administrator happened to save it
 * and starve every other tenant of a change that affects them too. Its payload
 * is `{ actorId, keys }`: configuration key *names*, carrying no tenant data.
 *
 * Consequence to be aware of when adding a subscriber: an org-scoped subject
 * that omits `orgId` from its payload is dropped for every actor rather than
 * broadcast to all of them. The fix for those is to stamp the orgId at the
 * publish site, not to widen this allowlist — as was done for
 * `quota.storage.exceeded` (platform/drive/store.ts), which had the orgId in
 * hand and simply was not including it.
 */
const GLOBAL_EVENT_SUBJECTS: ReadonlySet<string> = new Set([
  "signup.form_viewed",
  "helix.config.changed",
]);

/**
 * Depth limit for the payload scan. Deep enough for the nested shapes we
 * publish today (e.g. an org marker under an `actor` or `record` wrapper),
 * shallow enough that a hostile or runaway payload cannot make delivery
 * expensive.
 */
const MAX_ORG_SCAN_DEPTH = 6;

/**
 * Stand-in recorded when a payload has an org key whose value is not a string.
 * It can never equal a real `actor.orgId`, so a malformed marker fails closed
 * instead of being ignored (which would fall through to the unmarked path and
 * potentially deliver).
 */
const MALFORMED_ORG_MARKER = "\u0000malformed-org-marker";

const subjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((subject) => !/\s/u.test(subject), "Subject cannot contain whitespace.")
  .refine(
    (subject) => subject.split(".").every((token) => token.length > 0),
    "Subject tokens cannot be empty.",
  )
  .refine((subject) => {
    const tokens = subject.split(".");
    return tokens.every((token, index) => token !== ">" || index === tokens.length - 1);
  }, "Subject wildcard > must be the final token.");

const querySchema = z.object({
  subject: z.union([
    subjectSchema,
    z
      .array(subjectSchema)
      .nonempty()
      .transform((subjects) => subjects[0]),
  ]),
});

export async function registerEventRoutes(
  app: FastifyInstance,
  options: RegisterEventRoutesOptions,
): Promise<void> {
  app.get("/events/ws", { websocket: true }, async (socket, request) => {
    await handleEventSocket(socket as EventSocket, request, options);
  });
}

export async function handleEventSocket(
  socket: EventSocket,
  request: FastifyRequest,
  options: RegisterEventRoutesOptions,
): Promise<void> {
  // Follow-up B: count this connection on the active-connections gauge for the
  // lifetime of the socket.
  trackWebsocketConnection(socket, EVENTS_WS_ROUTE, options.metrics);

  const subject = parseSubject(request.query);
  if (subject === null) {
    socket.close(1008, "Missing or invalid subject query parameter");
    return;
  }

  const actor = await options.actorFromRequest(request);
  if (isUnauthenticated(actor)) {
    socket.close(1008, "Authentication required");
    return;
  }
  if (canMatchChatSubject(subject)) {
    socket.close(1008, "Chat events require the room-authorized Chat WebSocket");
    return;
  }

  if (options.bus === undefined) {
    socket.close(1013, "Event bus unavailable");
    return;
  }

  /* Reserve the slot only once the connection is known to be legitimate, so a
     rejected upgrade cannot consume an org's budget.
     Written as an explicit branch rather than `acquire(...) ?? noop`: `null` is
     nullish, so `??` would treat "the org is at its ceiling" as "no limiter
     configured" and admit the connection anyway. */
  let releaseStream: () => void = () => undefined;
  if (options.streamLimiter !== undefined) {
    const lease = options.streamLimiter.acquire(actor.orgId);
    if (lease === null) {
      /* 1013 rather than 1008: this is "try again later", not "you are not
         allowed", so the client's backoff ladder keeps retrying instead of
         giving up for good the way it does on an auth rejection. */
      socket.close(1013, "Too many concurrent event streams for this workspace");
      return;
    }
    releaseStream = lease;
  }

  let closed = false;
  let unsubscribe: Unsubscribe | undefined;

  socket.on("close", () => {
    closed = true;
    releaseStream();
    if (unsubscribe !== undefined) {
      const cleanup = unsubscribe;
      unsubscribe = undefined;
      void Promise.resolve(cleanup()).catch((error: unknown) => {
        options.onError?.(error);
      });
    }
  });

  socket.on("error", (error) => {
    options.onError?.(error);
  });

  try {
    unsubscribe = await options.bus.subscribe(subject, async (event) => {
      if (closed) {
        return;
      }
      if (!isVisibleToActor(event, actor)) {
        return;
      }
      sendEvent(socket, event);
    });
  } catch (error) {
    options.onError?.(error);
    socket.close(1011, "Event subscription failed");
  }
}

function parseSubject(query: unknown): string | null {
  const parsed = querySchema.safeParse(query);
  return parsed.success ? parsed.data.subject : null;
}

function isUnauthenticated(actor: Actor): boolean {
  return actor.id === unauthenticatedActor.id && actor.orgId === unauthenticatedActor.orgId;
}

/**
 * The generic event stream has no room-membership context. Chat payloads must
 * only flow through the dedicated Chat WebSocket, which checks tenant and room
 * membership both when the connection opens and before each delivery.
 */
function canMatchChatSubject(subject: string): boolean {
  const root = subject.split(".")[0];
  return root === "chat" || root === "*" || root === ">";
}

/**
 * Tenant gate for the generic event stream.
 *
 * Subscribing to a subject is not an authorization decision: the bus matches by
 * subject name, so an actor in org A who subscribes to a globally-named subject
 * such as `platform.ai_cost.warning`, `quota.api_rps.exceeded` or
 * `platform.pending_action.created` would otherwise receive org B's frames —
 * their tenant lives in the payload, not the subject. In
 * HELIX_MODE=multi-tenant-saas that is a cross-tenant leak of cost warnings,
 * quota breaches and pending approvals, so every envelope is re-checked here
 * before it reaches the socket.
 */
function isVisibleToActor(event: EventEnvelope, actor: Actor): boolean {
  // Consistent with actorHasScope in api/scopes.ts: the system actor is the
  // platform's own internal identity (it has no real tenant of its own — its
  // orgId is the all-zero placeholder), and every other gate lets it through.
  // Filtering it by orgId here would silently starve internal subscribers.
  if (actor.type === "system") {
    return true;
  }

  const orgIds = collectOrgMarkers(event.payload, 0, []);
  if (orgIds.length > 0) {
    // A mixed-tenant payload (one marker matching, another not) is dropped:
    // partial matches are how a foreign record smuggles itself in beside a
    // legitimate one.
    return orgIds.every((orgId) => orgId === actor.orgId);
  }

  // Subject-name-scoped subjects (`flags.changed.<orgId>`, chat rooms, sheet
  // sync) already encode the tenant, so an actor subscribing to
  // `flags.changed.*` keeps receiving their own org's frames even if a future
  // payload drops its orgId field.
  if (event.subject.split(".").includes(actor.orgId)) {
    return true;
  }

  return GLOBAL_EVENT_SUBJECTS.has(event.subject);
}

/**
 * Collects every org marker in a payload, at any depth, so that both shapes we
 * publish are caught: a top-level `orgId` (quota and pending-action events) and
 * one nested inside a wrapper object or array element.
 */
function collectOrgMarkers(value: JsonValue, depth: number, found: string[]): string[] {
  if (depth > MAX_ORG_SCAN_DEPTH || value === null || typeof value !== "object") {
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value as readonly JsonValue[]) {
      collectOrgMarkers(entry, depth + 1, found);
    }
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "orgId" || key === "org_id") {
      found.push(typeof entry === "string" && entry.length > 0 ? entry : MALFORMED_ORG_MARKER);
      continue;
    }
    collectOrgMarkers(entry, depth + 1, found);
  }
  return found;
}

function sendEvent(socket: EventSocket, event: EventEnvelope): void {
  socket.send(JSON.stringify(event));
}
