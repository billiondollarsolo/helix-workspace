import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { createTenantSpanProcessor } from "./tenant-span.js";

/**
 * Test-only OpenTelemetry harness: installs an in-memory tracer provider so
 * tests can assert the spans produced by instrumented code (P2-6).
 */
export interface SpanCaptureHarness {
  /** All spans finished since the last {@link reset}. */
  readonly spans: () => readonly ReadableSpan[];
  /** Span names finished since the last {@link reset}. */
  readonly spanNames: () => readonly string[];
  reset: () => void;
  /** Restore the previous global tracer provider. */
  dispose: () => Promise<void>;
}

/**
 * Install an in-memory tracer provider as the global provider. Call
 * {@link SpanCaptureHarness.dispose} (e.g. in `afterEach`) to restore.
 */
export function installSpanCapture(): SpanCaptureHarness {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [createTenantSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  return {
    spans: () => exporter.getFinishedSpans(),
    spanNames: () => exporter.getFinishedSpans().map((span) => span.name),
    reset: () => {
      exporter.reset();
    },
    dispose: async () => {
      await provider.shutdown();
      context.disable();
      trace.disable();
    },
  };
}
