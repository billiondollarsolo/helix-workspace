import { describe, expect, it } from "vitest";
import { createPlatformMetrics } from "./metrics.js";

describe("platform metrics", () => {
  it("records LLM routing, latency, cost, error, and fallback metrics", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordLLMChat({
      feature: "assistant.chat",
      providerId: "cloud",
      model: "gpt-test",
      status: "error",
      durationSeconds: 0.2,
      fallback: false,
      errorType: "Error",
    });
    metrics.recordLLMChat({
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
      'helix_llm_calls_total{provider="cloud",model="gpt-test",feature="assistant.chat",status="error"} 1',
    );
    expect(output).toContain(
      'helix_llm_errors_total{provider="cloud",model="gpt-test",feature="assistant.chat",error_type="Error"} 1',
    );
    expect(output).toContain(
      'helix_llm_calls_total{provider="local",model="llama-test",feature="assistant.chat",status="success"} 1',
    );
    expect(output).toContain(
      'helix_llm_latency_seconds_count{provider="local",model="llama-test",feature="assistant.chat",status="success"} 1',
    );
    expect(output).toContain(
      'helix_llm_cost_usd_micros_total{provider="local",model="llama-test",feature="assistant.chat"} 12500',
    );
    expect(output).toContain(
      'helix_llm_routing_fallback_total{provider="local",model="llama-test",feature="assistant.chat",status="success"} 1',
    );
    expect(output).not.toContain("actor_id=");
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

  it("records SCIM authentication failures without tenant, IP, or token labels", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordScimAuthFailure({ reason: "credential_expired" });

    const output = await metrics.registry.metrics();
    expect(output).toContain('helix_scim_auth_failures_total{reason="credential_expired"} 1');
    expect(output).not.toContain("org_id=");
    expect(output).not.toContain("source_ip=");
    expect(output).not.toContain("token=");
  });

  it("records signup funnel and activation SLO metrics without tenant or actor labels", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordSignupFunnelEvent({ step: "form_viewed" });
    metrics.recordSignupFunnelEvent({
      step: "verified",
      tier: "personal",
      planId: "personal",
      region: "default",
    });
    metrics.recordSignupActivationSlo({
      tier: "personal",
      planId: "personal",
      region: "default",
      durationSeconds: 42,
      withinTarget: true,
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain(
      'helix_signup_funnel_events_total{step="form_viewed",tier="unknown",plan_id="unknown",region="unknown"} 1',
    );
    expect(output).toContain(
      'helix_signup_funnel_events_total{step="verified",tier="personal",plan_id="personal",region="default"} 1',
    );
    expect(output).toContain(
      'helix_signup_activation_duration_seconds_count{tier="personal",plan_id="personal",region="default",within_target="true"} 1',
    );
    expect(output).toContain(
      'helix_signup_activation_duration_seconds_sum{tier="personal",plan_id="personal",region="default",within_target="true"} 42',
    );
    expect(output).not.toContain("org_id=");
    expect(output).not.toContain("org_slug=");
    expect(output).not.toContain("actor_id=");
    expect(output).not.toContain("owner@example.com");
    expect(output).not.toContain("token");
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

  it("records tenant storage pool size and eviction metrics", async () => {
    const metrics = createPlatformMetrics();

    metrics.setStoragePoolSize({ size: 2 });
    metrics.recordStoragePoolEviction();
    metrics.recordStoragePoolEviction();
    metrics.setStoragePoolSize({ size: 1 });

    const output = await metrics.registry.metrics();

    expect(output).toContain("helix_storage_pool_size 1");
    expect(output).toContain("helix_storage_pool_evictions_total 2");
  });

  it("records bounded-label search projection lag and failures", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordSearchProjection?.({ indexerId: "chat", status: "success", lagSeconds: 7 });
    metrics.recordSearchProjection?.({ indexerId: "chat", status: "error", lagSeconds: 12 });

    const output = await metrics.registry.metrics();
    expect(output).toContain('helix_search_projection_lag_seconds{indexer="chat"} 12');
    expect(output).toContain('helix_search_projection_errors_total{indexer="chat"} 1');
  });

  it("records bounded internal capability events, units, and state", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordOperationalEvent({
      capability: "mail",
      operation: "delivery",
      status: "error",
      durationSeconds: 2,
    });
    metrics.addOperationalUnits({ capability: "drive", measure: "uploaded_bytes", value: 42 });
    metrics.setOperationalState({ capability: "search", measure: "drift_objects", value: 3 });

    const output = await metrics.registry.metrics();
    expect(output).toContain(
      'helix_operational_events_total{capability="mail",operation="delivery",status="error"} 1',
    );
    expect(output).toContain(
      'helix_operational_duration_seconds_sum{capability="mail",operation="delivery",status="error"} 2',
    );
    expect(output).toContain(
      'helix_operational_units_total{capability="drive",measure="uploaded_bytes"} 42',
    );
    expect(output).toContain(
      'helix_operational_state{capability="search",measure="drift_objects"} 3',
    );
  });

  it("records privacy-safe Meet degradation without participant, room, media, or secret labels", async () => {
    const metrics = createPlatformMetrics();

    metrics.recordMeetParticipantEvent({ event: "joined" });
    metrics.recordMeetParticipantEvent({ event: "left", durationSeconds: 900 });
    metrics.recordMeetParticipantEvent({ event: "reconnected" });
    metrics.recordMeetParticipantEvent({ event: "device_failure", device: "camera" });
    metrics.recordMeetQuality({
      joinLatencySeconds: 4,
      packetLossPercent: 12,
      jitterSeconds: 0.25,
      rttSeconds: 0.8,
      bitrateKbps: 50,
      connectionQuality: 20,
      bridgeLoadPercent: 95,
      bridgeParticipantCount: 72,
    });

    const output = await metrics.registry.metrics();
    expect(output).toContain('helix_meet_participant_events_total{event="left",device="none"} 1');
    expect(output).toContain(
      'helix_meet_participant_events_total{event="device_failure",device="camera"} 1',
    );
    expect(output).toContain("helix_meet_call_duration_seconds_sum 900");
    expect(output).toContain("helix_meet_packet_loss_percent_sum 12");
    expect(output).toContain("helix_meet_jitter_seconds_sum 0.25");
    expect(output).toContain("helix_meet_rtt_seconds_sum 0.8");
    expect(output).toContain("helix_meet_bitrate_kbps_sum 50");
    expect(output).toContain("helix_meet_bridge_participant_load_sum 72");
    for (const signal of ["packet_loss", "jitter", "rtt", "bitrate", "bridge_load"]) {
      expect(output).toContain(`helix_meet_degraded_samples_total{signal="${signal}"} 1`);
    }
    expect(output).not.toContain("org_id=");
    expect(output).not.toContain("room_id=");
    expect(output).not.toContain("participant_id=");
    expect(output).not.toContain("token=");
    expect(output).not.toContain("secret=");
  });
});
