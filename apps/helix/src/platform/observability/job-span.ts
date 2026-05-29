import { SpanStatusCode, trace } from "@opentelemetry/api";
import { setSpanTenantAttributes, type TenantSpanContext } from "./tenant-span.js";

export interface JobSpanOptions {
  readonly tenant?: TenantSpanContext | undefined;
}

/**
 * Synthesizes a `job.<id>` span for one run of a background worker (P2-6).
 *
 * Background workers (outbox poller, pending-action expiry sweep, …) run on a
 * timer with no incoming request, so they have no ambient trace context. This
 * helper starts a fresh root span named `job.<id>` for each discrete run so the
 * work is observable alongside the LLM / tool / MCP / SMTP spans.
 *
 * The span records exceptions and marks an error status, then re-throws so the
 * worker's own error handling is unchanged.
 */
export async function withJobSpan<T>(
  jobId: string,
  run: () => Promise<T>,
  options: JobSpanOptions = {},
): Promise<T> {
  return trace.getTracer("helix.jobs").startActiveSpan(
    `job.${jobId}`,
    { attributes: { "helix.job.id": jobId } },
    async (span) => {
      if (options.tenant !== undefined) {
        setSpanTenantAttributes(span, options.tenant);
      }
      try {
        return await run();
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
