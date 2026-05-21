import { describe, expect, it } from "vitest";
import {
  NatsEventBus,
  traceContextFromNatsHeaders,
  traceContextToNatsHeaders,
} from "./nats-event-bus.js";
import type { NatsConnection, Payload, PublishOptions } from "@nats-io/transport-node";

describe("NatsEventBus", () => {
  it("publishes JSON payloads with subject prefix and W3C trace headers", async () => {
    const publications: {
      readonly subject: string;
      readonly payload?: Payload;
      readonly options?: PublishOptions;
    }[] = [];
    const connection = {
      publish(subject: string, payload?: Payload, options?: PublishOptions): void {
        publications.push({
          subject,
          ...(payload === undefined ? {} : { payload }),
          ...(options === undefined ? {} : { options }),
        });
      },
      flush: async () => {},
    } as unknown as NatsConnection;
    const bus = new NatsEventBus(connection, { subjectPrefix: "helix.platform" });

    await bus.publish(
      "config.changed",
      { ok: true },
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        tracestate: "vendor=value",
      },
    );

    expect(publications).toHaveLength(1);
    expect(publications[0]?.subject).toBe("helix.platform.config.changed");
    expect(publications[0]?.payload).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(publications[0]?.payload as Uint8Array))).toEqual({ ok: true });
    expect(publications[0]?.options?.headers?.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(publications[0]?.options?.headers?.get("tracestate")).toBe("vendor=value");
  });

  it("round-trips W3C trace context through NATS headers", () => {
    const headers = traceContextToNatsHeaders({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });

    expect(traceContextFromNatsHeaders(headers)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
  });
});
