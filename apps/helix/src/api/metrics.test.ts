import { describe, expect, it } from "vitest";
import { createPlatformMetrics } from "./metrics.js";

describe("platform metrics", () => {
  it("records LLM routing, latency, cost, error, and fallback metrics", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordLLMChat({
      actorId: "actor-1",
      feature: "assistant.chat",
      providerId: "cloud",
      model: "gpt-test",
      status: "error",
      durationSeconds: 0.2,
      fallback: false,
      errorType: "Error",
    });
    metrics.recordLLMChat({
      actorId: "actor-1",
      feature: "assistant.chat",
      providerId: "local",
      model: "llama-test",
      status: "success",
      durationSeconds: 0.4,
      fallback: true,
      costCents: 1.25,
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain(
      'helix_llm_calls_total{provider="cloud",model="gpt-test",feature="assistant.chat",actor_id="actor-1",status="error"} 1',
    );
    expect(output).toContain(
      'helix_llm_errors_total{provider="cloud",model="gpt-test",feature="assistant.chat",actor_id="actor-1",error_type="Error"} 1',
    );
    expect(output).toContain(
      'helix_llm_calls_total{provider="local",model="llama-test",feature="assistant.chat",actor_id="actor-1",status="success"} 1',
    );
    expect(output).toContain(
      'helix_llm_latency_seconds_count{provider="local",model="llama-test",feature="assistant.chat",actor_id="actor-1",status="success"} 1',
    );
    expect(output).toContain(
      'helix_llm_cost_usd_micros_total{provider="local",model="llama-test",feature="assistant.chat",actor_id="actor-1"} 12500',
    );
    expect(output).toContain(
      'helix_llm_routing_fallback_total{provider="local",model="llama-test",feature="assistant.chat",actor_id="actor-1",status="success"} 1',
    );
  });

  it("records audit activity and hash-chain verifier metrics used by Grafana", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordPermissionCheck({
      action: "mail.read",
      actorType: "agent",
      decision: "allow",
      durationSeconds: 0.004,
      policy: "cerbos",
      resourceType: "tool",
    });
    metrics.recordAuditActivity({ verb: "agent.credential.created", objectType: "tool" });
    metrics.recordAuditHashChainVerification({
      failedOrgCount: 2,
      verifiedAtSeconds: 1_779_302_400,
    });
    metrics.recordAuditShipping({
      destination: "immutable-s3",
      recordCount: 3,
      lagSeconds: 12,
    });
    metrics.recordAuditShippingFailure({ destination: "immutable-s3" });
    metrics.setAuditShippingBacklog({
      destination: "immutable-s3",
      recordCount: 5,
      lagSeconds: 30,
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain(
      'helix_permission_checks_total{policy="cerbos",resource_type="tool",action="mail.read",actor_type="agent",decision="allow"} 1',
    );
    expect(output).toContain(
      'helix_permission_check_duration_seconds_count{policy="cerbos",resource_type="tool",action="mail.read",actor_type="agent",decision="allow"} 1',
    );
    expect(output).toContain(
      'helix_audit_activity_total{verb="agent.credential.created",object_type="tool"} 1',
    );
    expect(output).toContain("helix_audit_hash_chain_failures_total 2");
    expect(output).toContain("helix_audit_hash_chain_last_verified_timestamp_seconds 1779302400");
    expect(output).toContain('helix_audit_shipping_records_total{destination="immutable-s3"} 3');
    expect(output).toContain('helix_audit_shipping_failures_total{destination="immutable-s3"} 1');
    expect(output).toContain('helix_audit_shipping_backlog_records{destination="immutable-s3"} 5');
    expect(output).toContain('helix_audit_shipping_lag_seconds{destination="immutable-s3"} 30');
  });

  it("records agent tool limiter denial metrics without high-cardinality actor labels", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordAgentToolLimiterDenial({
      toolId: "platform.ping",
      tier: "business",
      actorType: "agent",
      reason: "requests_per_minute",
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain(
      'helix_agent_tool_limiter_denials_total{tool_id="platform.ping",tier="business",actor_type="agent",reason="requests_per_minute"} 1',
    );
    expect(output).not.toContain("actor_id=");
  });

  it("tracks the helix_websocket_connections_active gauge per route (Follow-up B)", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordWebsocketConnectionOpened({ route: "/ws/chat" });
    metrics.recordWebsocketConnectionOpened({ route: "/ws/chat" });
    metrics.recordWebsocketConnectionOpened({ route: "/sync/docs/:docId" });
    metrics.recordWebsocketConnectionClosed({ route: "/ws/chat" });

    const output = await metrics.registry.metrics();

    expect(output).toContain('helix_websocket_connections_active{route="/ws/chat"} 1');
    expect(output).toContain('helix_websocket_connections_active{route="/sync/docs/:docId"} 1');
  });
});
