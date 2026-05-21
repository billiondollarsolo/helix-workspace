import type { FastifyRequest } from "fastify";
import type { RequestContext, TraceContext } from "@helix/sdk-types";

export interface PropagatedTraceContext extends TraceContext {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface TraceCarrier {
  readonly traceparent?: string | readonly string[];
  readonly tracestate?: string | readonly string[];
}

const traceparentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const emptyTraceId = "00000000000000000000000000000000";
const emptySpanId = "0000000000000000";

export function extractTraceContext(carrier: TraceCarrier): PropagatedTraceContext {
  const traceparent = firstHeaderValue(carrier.traceparent);
  const tracestate = firstHeaderValue(carrier.tracestate);

  if (traceparent === undefined) {
    return tracestate === undefined ? {} : { tracestate };
  }

  const match = traceparentPattern.exec(traceparent);
  if (match === null) {
    return tracestate === undefined ? {} : { tracestate };
  }

  const [, , traceId, spanId] = match;
  if (
    traceId === undefined ||
    spanId === undefined ||
    traceId === emptyTraceId ||
    spanId === emptySpanId
  ) {
    return tracestate === undefined ? {} : { tracestate };
  }

  return {
    traceId,
    spanId,
    traceparent,
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

export function extractTraceContextFromRequest(request: FastifyRequest): PropagatedTraceContext {
  return extractTraceContext({
    ...(request.headers.traceparent === undefined ? {} : { traceparent: request.headers.traceparent }),
    ...(request.headers.tracestate === undefined ? {} : { tracestate: request.headers.tracestate }),
  });
}

export function createRequestContext(request: FastifyRequest): RequestContext {
  const trace = extractTraceContextFromRequest(request);
  const userAgent = firstHeaderValue(request.headers["user-agent"]);

  return {
    requestId: request.id,
    ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
    ...(trace.spanId === undefined ? {} : { spanId: trace.spanId }),
    ip: request.ip,
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

export function injectTraceContext(
  headers: Record<string, string>,
  trace: PropagatedTraceContext,
): Record<string, string> {
  return {
    ...headers,
    ...(trace.traceparent === undefined ? {} : { traceparent: trace.traceparent }),
    ...(trace.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
  };
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.[0];
}
