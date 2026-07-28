import type { Actor, EventBus, EventEnvelope, Unsubscribe } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import { unauthenticatedActor } from "../../api/actor.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";

interface EventSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RegisterEventRoutesOptions {
  readonly bus?: EventBus | undefined;
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

  if (options.bus === undefined) {
    socket.close(1013, "Event bus unavailable");
    return;
  }

  let closed = false;
  let unsubscribe: Unsubscribe | undefined;

  socket.on("close", () => {
    closed = true;
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

function sendEvent(socket: EventSocket, event: EventEnvelope): void {
  socket.send(JSON.stringify(event));
}
