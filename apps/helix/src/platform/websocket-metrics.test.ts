import { trace, ROOT_CONTEXT } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  trackWebsocketConnection,
  traceContextFromUpgradeRequest,
  type WebsocketConnectionMetrics,
} from "./websocket-metrics.js";

function recordingMetrics(): WebsocketConnectionMetrics & {
  readonly opened: string[];
  readonly closed: string[];
} {
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    opened,
    closed,
    recordWebsocketConnectionOpened: ({ route }) => {
      opened.push(route);
    },
    recordWebsocketConnectionClosed: ({ route }) => {
      closed.push(route);
    },
  };
}

interface FakeSocket {
  on(event: "close", handler: () => void): void;
  fireClose(): void;
}

function fakeSocket(): FakeSocket {
  let handler: (() => void) | undefined;
  return {
    on: (_event, h) => {
      handler = h;
    },
    fireClose: () => {
      handler?.();
    },
  };
}

describe("trackWebsocketConnection (Follow-up B)", () => {
  it("increments on connect and decrements once on close", () => {
    const metrics = recordingMetrics();
    const socket = fakeSocket();

    trackWebsocketConnection(socket, "/ws/chat", metrics);
    expect(metrics.opened).toEqual(["/ws/chat"]);
    expect(metrics.closed).toEqual([]);

    socket.fireClose();
    socket.fireClose();
    expect(metrics.closed).toEqual(["/ws/chat"]);
  });

  it("is a no-op when metrics are undefined", () => {
    const socket = fakeSocket();
    expect(() => {
      trackWebsocketConnection(socket, "/ws/chat", undefined);
    }).not.toThrow();
  });
});

describe("traceContextFromUpgradeRequest (P2-6)", () => {
  it("returns the root context when no traceparent header is present", () => {
    const request = { headers: {} } as unknown as FastifyRequest;
    expect(traceContextFromUpgradeRequest(request)).toBe(ROOT_CONTEXT);
  });

  it("extracts a span context from a W3C traceparent on the upgrade request", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    const request = {
      headers: { traceparent: `00-${traceId}-${spanId}-01` },
    } as unknown as FastifyRequest;

    const ctx = traceContextFromUpgradeRequest(request);
    const spanContext = trace.getSpanContext(ctx);
    expect(spanContext?.traceId).toBe(traceId);
    expect(spanContext?.spanId).toBe(spanId);
  });
});
