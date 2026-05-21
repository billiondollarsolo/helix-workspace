import { type Context, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { FastifyRequest } from "fastify";
import { extractTraceContextFromRequest } from "../api/trace.js";

/**
 * W3C `traceparter`/`tracestate` propagator used to lift trace context off the
 * WebSocket upgrade request. Used directly rather than the global propagator so
 * extraction works regardless of whether a global propagator was registered.
 */
const w3cPropagator = new W3CTraceContextPropagator();

const headerGetter = {
  keys: (carrier: Record<string, string>): string[] => Object.keys(carrier),
  get: (carrier: Record<string, string>, key: string): string | undefined => carrier[key],
};

/**
 * Records active WebSocket connections for the
 * `helix_websocket_connections_active` Prometheus gauge (Follow-up B).
 *
 * Only the connect/disconnect methods are needed by the WS routes, so they
 * accept this narrowed view of `PlatformMetrics` rather than the whole object.
 */
export interface WebsocketConnectionMetrics {
  recordWebsocketConnectionOpened(input: { readonly route: string }): void;
  recordWebsocketConnectionClosed(input: { readonly route: string }): void;
}

/** Minimal socket surface needed to register a one-shot close handler. */
interface ClosableSocket {
  on(event: "close", handler: () => void): void;
}

/**
 * Track a WebSocket connection on the active-connections gauge.
 *
 * Increments the gauge immediately and decrements it exactly once when the
 * socket closes. Safe to call when `metrics` is undefined (gauge disabled).
 */
export function trackWebsocketConnection(
  socket: ClosableSocket,
  route: string,
  metrics: WebsocketConnectionMetrics | undefined,
): void {
  if (metrics === undefined) {
    return;
  }
  metrics.recordWebsocketConnectionOpened({ route });
  let closed = false;
  socket.on("close", () => {
    if (closed) {
      return;
    }
    closed = true;
    metrics.recordWebsocketConnectionClosed({ route });
  });
}

/**
 * Extract W3C trace context from a WebSocket upgrade request (P2-6).
 *
 * The HTTP upgrade request carries `traceparent` / `tracestate` headers. This
 * builds an OpenTelemetry {@link Context} from them so spans created for the
 * lifetime of the socket (e.g. `yjs.sync`) are children of the originating
 * client trace — trace context rides the socket, not just the event envelope.
 * Returns {@link ROOT_CONTEXT} when no valid `traceparent` is present.
 */
export function traceContextFromUpgradeRequest(request: FastifyRequest): Context {
  // The upgrade request may be a minimal stub (e.g. in tests) without a
  // `headers` object; guard so trace extraction never throws.
  const headers = (request as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) {
    return ROOT_CONTEXT;
  }
  const trace = extractTraceContextFromRequest(request);
  if (trace.traceparent === undefined) {
    return ROOT_CONTEXT;
  }
  const carrier: Record<string, string> = { traceparent: trace.traceparent };
  if (trace.tracestate !== undefined) {
    carrier.tracestate = trace.tracestate;
  }
  return w3cPropagator.extract(ROOT_CONTEXT, carrier, headerGetter);
}
