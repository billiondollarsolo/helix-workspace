import type { EventBus, EventEnvelope, Unsubscribe } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ForbiddenError, RateLimitedError, UnauthorizedError } from "../../api/api-error.js";

import { EventStreamLimiter } from "../events/stream-limit.js";

const MAIL_ACTIVITY_SUBJECTS = [
  "activity.mail.received",
  "activity.mail.sent",
  "activity.mail.updated",
] as const;

/** `mail.updated`: server-side mailbox change (e.g. the decision model filed a thread in Spam). */
type MailStreamEventType = "mail.received" | "mail.sent" | "mail.updated";

export interface MailStreamFrame {
  readonly type: MailStreamEventType;
  readonly threadId: string;
  readonly orgId: string;
}

interface MailStreamActor {
  readonly id: string;
  readonly orgId: string;
}

export interface RegisterMailStreamOptions {
  readonly events: EventBus;
  readonly streamLimiter?: EventStreamLimiter;
  /**
   * Resolve the authenticated actor for the SSE connection. Return null to
   * reject with 401.
   */
  readonly resolveActor: (
    request: FastifyRequest,
  ) => Promise<MailStreamActor | null> | MailStreamActor | null;
}

/**
 * Map an activity.mail.* outbox subject + payload into a client SSE frame.
 * Returns null when the event is not relevant (wrong subject shape / missing
 * threadId / mailbox mismatch). Pure — unit-tested without sockets.
 */
export function frameForMailActivity(input: {
  readonly subject: string;
  readonly payload: unknown;
  readonly actorOrgId: string;
  readonly actorId: string;
}): MailStreamFrame | null {
  const type = mailStreamEventType(input.subject);
  if (type === null) {
    return null;
  }
  if (typeof input.payload !== "object" || input.payload === null) {
    return null;
  }
  const payload = input.payload as Record<string, unknown>;
  const threadId =
    typeof payload.threadId === "string"
      ? payload.threadId
      : typeof payload.thread_id === "string"
        ? payload.thread_id
        : null;
  const orgId =
    typeof payload.orgId === "string"
      ? payload.orgId
      : typeof payload.org_id === "string"
        ? payload.org_id
        : null;
  const actorId =
    typeof payload.actorId === "string"
      ? payload.actorId
      : typeof payload.actor_id === "string"
        ? payload.actor_id
        : null;
  if (threadId === null || orgId === null || actorId === null) {
    return null;
  }
  // Authz filter: activity is private to the mailbox that owns its state row.
  if (orgId !== input.actorOrgId || actorId !== input.actorId) {
    return null;
  }
  return { type, threadId, orgId };
}

function mailStreamEventType(subject: string): MailStreamEventType | null {
  switch (subject) {
    case "activity.mail.received":
      return "mail.received";
    case "activity.mail.sent":
      return "mail.sent";
    case "activity.mail.updated":
      return "mail.updated";
    default:
      return null;
  }
}

export function formatMailSseEvent(frame: MailStreamFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Register `GET /sse/mail` — Server-Sent Events over the existing
 * activity.mail.* outbox→EventBus seam (no second bus).
 */
export function registerMailStreamRoutes(
  app: FastifyInstance,
  options: RegisterMailStreamOptions,
): void {
  const limiter = options.streamLimiter ?? new EventStreamLimiter();
  app.get("/sse/mail", async (request, reply) => {
    const actor = await options.resolveActor(request);
    if (actor === null || actor.id === "anonymous") {
      throw new UnauthorizedError("Authentication required for mail SSE.");
    }
    if (actor.orgId.length === 0) {
      throw new ForbiddenError("Mail SSE requires an org-scoped actor.");
    }

    const release = limiter.acquire(actor.orgId);
    if (release === null) throw new RateLimitedError("Too many concurrent mail streams.");
    const unsubscribers: Unsubscribe[] = [];
    const state = { closed: false };
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      release();
      for (const unsub of unsubscribers.splice(0)) {
        void Promise.resolve(unsub()).catch(() => undefined);
      }
      reply.raw.end();
    };
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(": ok\n\n");

    const writeFrame = async (event: EventEnvelope): Promise<void> => {
      if (state.closed) return;
      const frame = frameForMailActivity({
        subject: event.subject,
        payload: event.payload,
        actorOrgId: actor.orgId,
        actorId: actor.id,
      });
      if (frame === null) return;
      try {
        const current = await options.resolveActor(request);
        if (current?.id !== actor.id || current.orgId !== actor.orgId) {
          cleanup();
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Close callbacks can run during authentication.
        if (!state.closed && !reply.raw.write(formatMailSseEvent(frame))) cleanup();
      } catch {
        cleanup();
      }
    };
    try {
      for (const subject of MAIL_ACTIVITY_SUBJECTS) {
        if (state.closed) break;
        const unsub = await options.events.subscribe(subject, writeFrame);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The client can disconnect while subscription setup awaits.
        if (state.closed) await unsub();
        else unsubscribers.push(unsub);
      }
    } catch (error) {
      cleanup();
      throw error;
    }
  });
}

/** Test helper: drive frame filtering without a Fastify instance. */
export async function handleMailStreamEventForTest(
  reply: { write: (chunk: string) => void },
  input: {
    readonly subject: string;
    readonly payload: unknown;
    readonly actorOrgId: string;
    readonly actorId: string;
  },
): Promise<boolean> {
  const frame = frameForMailActivity(input);
  if (frame === null) {
    return false;
  }
  reply.write(formatMailSseEvent(frame));
  return true;
}
