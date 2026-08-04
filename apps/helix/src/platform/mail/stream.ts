import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EventBus, EventEnvelope, Unsubscribe } from "@helix/sdk-types";
import { ForbiddenError, UnauthorizedError } from "../../api/api-error.js";

const MAIL_ACTIVITY_SUBJECTS = ["activity.mail.received", "activity.mail.sent"] as const;

export type MailStreamEventType = "mail.received" | "mail.sent";

export interface MailStreamFrame {
  readonly type: MailStreamEventType;
  readonly threadId: string;
  readonly orgId: string;
}

export interface MailStreamActor {
  readonly id: string;
  readonly orgId: string;
}

export interface RegisterMailStreamOptions {
  readonly events: EventBus;
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
 * threadId / org mismatch). Pure — unit-tested without sockets.
 */
export function frameForMailActivity(input: {
  readonly subject: string;
  readonly payload: unknown;
  readonly actorOrgId: string;
}): MailStreamFrame | null {
  const type = mailStreamEventType(input.subject);
  if (type === null) {
    return null;
  }
  if (typeof input.payload !== "object" || input.payload === null) {
    return null;
  }
  const payload = input.payload as Record<string, unknown>;
  const threadId = firstStringValue(payload, "threadId", "thread_id");
  const orgId = firstStringValue(payload, "orgId", "org_id");
  if (threadId === null || orgId === null) {
    return null;
  }
  // Authz filter: never deliver another org's activity to this connection.
  if (orgId !== input.actorOrgId) {
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
    default:
      return null;
  }
}

/** First key holding a string value — payloads use camelCase or snake_case. */
function firstStringValue(
  payload: Record<string, unknown>,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return null;
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
  app.get("/sse/mail", async (request, reply) => {
    const actor = await options.resolveActor(request);
    if (actor === null) {
      throw new UnauthorizedError("Authentication required for mail SSE.");
    }
    if (actor.orgId.length === 0) {
      throw new ForbiddenError("Mail SSE requires an org-scoped actor.");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(": ok\n\n");

    const unsubscribers: Unsubscribe[] = [];
    const writeFrame = (event: EventEnvelope): void => {
      const frame = frameForMailActivity({
        subject: event.subject,
        payload: event.payload,
        actorOrgId: actor.orgId,
      });
      if (frame === null) {
        return;
      }
      reply.raw.write(formatMailSseEvent(frame));
    };

    try {
      for (const subject of MAIL_ACTIVITY_SUBJECTS) {
        const unsub = await options.events.subscribe(subject, async (event) => {
          writeFrame(event);
        });
        unsubscribers.push(unsub);
      }
    } catch (error) {
      for (const unsub of unsubscribers) {
        await Promise.resolve(unsub()).catch(() => undefined);
      }
      reply.raw.end();
      throw error;
    }

    const cleanup = () => {
      void (async () => {
        for (const unsub of unsubscribers) {
          await Promise.resolve(unsub()).catch(() => undefined);
        }
      })();
    };
    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
  });
}

/** Test helper: drive frame filtering without a Fastify instance. */
export async function handleMailStreamEventForTest(
  reply: { write: (chunk: string) => void },
  input: {
    readonly subject: string;
    readonly payload: unknown;
    readonly actorOrgId: string;
  },
): Promise<boolean> {
  const frame = frameForMailActivity(input);
  if (frame === null) {
    return false;
  }
  reply.write(formatMailSseEvent(frame));
  return true;
}

// Keep FastifyReply type referenced for future auth middleware composition.
export type { FastifyReply };
