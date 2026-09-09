import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from "prom-client";
import type { SecurityScanningMetrics } from "../platform/security/scanning/metrics.js";

export type ToolMetricStatus = "executed" | "pending_confirmation" | "error";
export type OperationalMetricStatus = "success" | "error" | "retry" | "blocked" | "dry_run";
export type OperationalCapability = "mail" | "drive" | "chat" | "search";
export type OperationalOperation =
  | "queue_wait"
  | "delivery"
  | "fanout"
  | "replay"
  | "finalize"
  | "download"
  | "virus_scan"
  | "quota"
  | "reconcile";
export type OperationalMeasure =
  | "replayed_events"
  | "uploaded_bytes"
  | "downloaded_bytes"
  | "quarantined_bytes"
  | "reconciled_documents"
  | "drift_objects";

export interface PlatformMetrics extends SecurityScanningMetrics {
  readonly registry: Registry;
  recordLLMChat(input: {
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly status: "success" | "error";
    readonly durationSeconds: number;
    readonly fallback: boolean;
    readonly costCents?: number | undefined;
    readonly errorType?: string | undefined;
  }): void;
  recordToolInvocation(input: {
    readonly toolId: string;
    readonly status: ToolMetricStatus;
    readonly durationSeconds: number;
  }): void;
  recordAgentToolLimiterDenial(input: {
    readonly toolId: string;
    readonly tier: string;
    readonly actorType: string;
    readonly reason: string;
  }): void;
  recordScimAuthFailure(input: { readonly reason: string }): void;
  recordAgentOperationalControlDenial(input: {
    readonly toolId: string;
    readonly actorType: string;
    readonly reason: string;
  }): void;
  recordToolPolicyDenial(input: {
    readonly toolId: string;
    readonly reason: string;
    readonly requestChannel: string;
    readonly effectiveClassification: string;
  }): void;
  recordSignupFunnelEvent(input: {
    readonly step: string;
    readonly tier?: string | undefined;
    readonly planId?: string | undefined;
    readonly region?: string | undefined;
  }): void;
  recordSignupActivationSlo(input: {
    readonly tier: string;
    readonly planId: string;
    readonly region: string;
    readonly durationSeconds: number;
    readonly withinTarget: boolean;
  }): void;
  recordPermissionCheck(input: {
    readonly action: string;
    readonly actorType: string;
    readonly decision: "allow" | "deny" | "error";
    readonly durationSeconds: number;
    readonly policy: string;
    readonly resourceType: string;
  }): void;
  recordAuditActivity(input: { readonly verb: string; readonly objectType: string }): void;
  recordAuditHashChainVerification(input: {
    readonly failedOrgCount: number;
    readonly verifiedAtSeconds: number;
  }): void;
  recordAuditShipping(input: {
    readonly destination: string;
    readonly recordCount: number;
    readonly lagSeconds: number;
  }): void;
  recordAuditShippingFailure(input: { readonly destination: string }): void;
  setAuditShippingBacklog(input: {
    readonly destination: string;
    readonly recordCount: number;
    readonly lagSeconds: number;
  }): void;
  /**
   * Records a WebSocket connecting on a route (Follow-up B). Increments the
   * `helix_websocket_connections_active` gauge that the Helm HPA scales on.
   */
  recordWebsocketConnectionOpened(input: { readonly route: string }): void;
  /** Records a WebSocket disconnecting on a route, decrementing the gauge. */
  recordWebsocketConnectionClosed(input: { readonly route: string }): void;
  setStoragePoolSize(input: { readonly size: number }): void;
  recordStoragePoolEviction(): void;
  recordMeetParticipantEvent(input: {
    readonly event: "joined" | "left" | "reconnected" | "device_failure";
    readonly device?: "camera" | "microphone" | "screen" | undefined;
    readonly durationSeconds?: number | undefined;
  }): void;
  recordMeetQuality(input: {
    readonly joinLatencySeconds?: number | undefined;
    readonly packetLossPercent?: number | undefined;
    readonly jitterSeconds?: number | undefined;
    readonly rttSeconds?: number | undefined;
    readonly bitrateKbps?: number | undefined;
    readonly connectionQuality?: number | undefined;
    readonly bridgeLoadPercent?: number | undefined;
    readonly bridgeParticipantCount?: number | undefined;
  }): void;
  readonly recordSearchProjection?: (input: {
    readonly indexerId: string;
    readonly status: "success" | "error";
    readonly lagSeconds: number;
  }) => void;
  recordOperationalEvent(input: {
    readonly capability: OperationalCapability;
    readonly operation: OperationalOperation;
    readonly status: OperationalMetricStatus;
    readonly durationSeconds?: number | undefined;
  }): void;
  addOperationalUnits(input: {
    readonly capability: OperationalCapability;
    readonly measure: OperationalMeasure;
    readonly value?: number | undefined;
  }): void;
  setOperationalState(input: {
    readonly capability: OperationalCapability;
    readonly measure: OperationalMeasure;
    readonly value: number;
  }): void;
}

export function createPlatformMetrics(): PlatformMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "helix_" });

  const toolInvocations = new Counter({
    name: "helix_tool_invocations_total",
    help: "Total platform tool invocations.",
    labelNames: ["tool_id", "status"],
    registers: [registry],
  });

  const toolDuration = new Histogram({
    name: "helix_tool_invocation_duration_seconds",
    help: "Platform tool invocation duration in seconds.",
    labelNames: ["tool_id", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const agentToolLimiterDenials = new Counter({
    name: "helix_agent_tool_limiter_denials_total",
    help: "Total denied agent or service-account tool invocations by limiter reason.",
    labelNames: ["tool_id", "tier", "actor_type", "reason"],
    registers: [registry],
  });
  const scimAuthFailures = new Counter({
    name: "helix_scim_auth_failures_total",
    help: "Total rejected SCIM authentication and authorization attempts by reason.",
    labelNames: ["reason"],
    registers: [registry],
  });
  const agentOperationalControlDenials = new Counter({
    name: "helix_agent_operational_control_denials_total",
    help: "Total content-free tool denials caused by emergency operational controls.",
    labelNames: ["tool_id", "actor_type", "reason"],
    registers: [registry],
  });
  const toolPolicyDenials = new Counter({
    name: "helix_tool_policy_denials_total",
    help: "Total content-free policy-firewall denials by tool, reason, channel, and classification.",
    labelNames: ["tool_id", "reason", "request_channel", "classification"],
    registers: [registry],
  });
  const signupFunnelEvents = new Counter({
    name: "helix_signup_funnel_events_total",
    help: "Total privacy-safe signup funnel events by step and plan dimensions.",
    labelNames: ["step", "tier", "plan_id", "region"],
    registers: [registry],
  });
  const signupActivationDuration = new Histogram({
    name: "helix_signup_activation_duration_seconds",
    help: "Self-service signup activation duration by plan dimensions and SLO target result.",
    labelNames: ["tier", "plan_id", "region", "within_target"],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
    registers: [registry],
  });
  const llmCalls = new Counter({
    name: "helix_llm_calls_total",
    help: "Total LLM chat attempts by provider, model, feature, and status.",
    labelNames: ["provider", "model", "feature", "status"],
    registers: [registry],
  });
  const llmLatency = new Histogram({
    name: "helix_llm_latency_seconds",
    help: "LLM chat attempt latency in seconds.",
    labelNames: ["provider", "model", "feature", "status"],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  const llmCost = new Counter({
    name: "helix_llm_cost_usd_micros_total",
    help: "Total estimated or reported LLM cost in USD micros.",
    labelNames: ["provider", "model", "feature"],
    registers: [registry],
  });
  const llmErrors = new Counter({
    name: "helix_llm_errors_total",
    help: "Total failed LLM chat attempts by provider, model, feature, and error type.",
    labelNames: ["provider", "model", "feature", "error_type"],
    registers: [registry],
  });
  const llmFallbacks = new Counter({
    name: "helix_llm_routing_fallback_total",
    help: "Total LLM fallback route attempts by provider, model, feature, and status.",
    labelNames: ["provider", "model", "feature", "status"],
    registers: [registry],
  });
  const auditActivity = new Counter({
    name: "helix_audit_activity_total",
    help: "Total audit activity records appended by verb and object type.",
    labelNames: ["verb", "object_type"],
    registers: [registry],
  });
  const auditHashChainFailures = new Counter({
    name: "helix_audit_hash_chain_failures_total",
    help: "Total failed audit hash-chain verifier org results.",
    registers: [registry],
  });
  const auditHashChainLastVerified = new Gauge({
    name: "helix_audit_hash_chain_last_verified_timestamp_seconds",
    help: "Unix timestamp for the latest completed audit hash-chain verifier run.",
    registers: [registry],
  });
  const auditShippingRecords = new Counter({
    name: "helix_audit_shipping_records_total",
    help: "Total audit records shipped to immutable destinations.",
    labelNames: ["destination"],
    registers: [registry],
  });
  const auditShippingFailures = new Counter({
    name: "helix_audit_shipping_failures_total",
    help: "Total audit shipping failures by destination.",
    labelNames: ["destination"],
    registers: [registry],
  });
  const auditShippingLag = new Gauge({
    name: "helix_audit_shipping_lag_seconds",
    help: "Seconds between now and the oldest unshipped audit record, or latest shipped batch lag when backlog is empty.",
    labelNames: ["destination"],
    registers: [registry],
  });
  const auditShippingBacklog = new Gauge({
    name: "helix_audit_shipping_backlog_records",
    help: "Number of audit records waiting to be shipped by destination.",
    labelNames: ["destination"],
    registers: [registry],
  });
  const websocketConnectionsActive = new Gauge({
    name: "helix_websocket_connections_active",
    help: "Currently open WebSocket connections by route. Referenced by the Helm HPA.",
    labelNames: ["route"],
    registers: [registry],
  });
  const storagePoolSize = new Gauge({
    name: "helix_storage_pool_size",
    help: "Resolved tenant object-storage clients currently cached in this process.",
    registers: [registry],
  });
  const storagePoolEvictions = new Counter({
    name: "helix_storage_pool_evictions_total",
    help: "Total resolved tenant object-storage client cache evictions in this process.",
    registers: [registry],
  });
  const permissionChecks = new Counter({
    name: "helix_permission_checks_total",
    help: "Total platform permission checks by policy, resource type, action, actor type, and decision.",
    labelNames: ["policy", "resource_type", "action", "actor_type", "decision"],
    registers: [registry],
  });
  const permissionCheckDuration = new Histogram({
    name: "helix_permission_check_duration_seconds",
    help: "Platform permission check duration in seconds.",
    labelNames: ["policy", "resource_type", "action", "actor_type", "decision"],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });
  const searchProjectionLag = new Gauge({
    name: "helix_search_projection_lag_seconds",
    help: "Age of the latest search projection event when processing completed.",
    labelNames: ["indexer"],
    registers: [registry],
  });
  const searchProjectionErrors = new Counter({
    name: "helix_search_projection_errors_total",
    help: "Total search projection failures by indexer.",
    labelNames: ["indexer"],
    registers: [registry],
  });
  const operationalEvents = new Counter({
    name: "helix_operational_events_total",
    help: "Bounded internal capability outcomes not represented by HTTP or tool requests.",
    labelNames: ["capability", "operation", "status"],
    registers: [registry],
  });
  const operationalDuration = new Histogram({
    name: "helix_operational_duration_seconds",
    help: "Duration of bounded internal capability operations.",
    labelNames: ["capability", "operation", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [registry],
  });
  const operationalUnits = new Counter({
    name: "helix_operational_units_total",
    help: "Bounded business units processed by internal capabilities.",
    labelNames: ["capability", "measure"],
    registers: [registry],
  });
  const operationalState = new Gauge({
    name: "helix_operational_state",
    help: "Current bounded operational state such as detected reconciliation drift.",
    labelNames: ["capability", "measure"],
    registers: [registry],
  });
  const meetParticipantEvents = new Counter({
    name: "helix_meet_participant_events_total",
    help: "Privacy-safe Meet participant events from signed media or Jitsi lifecycle signals.",
    labelNames: ["event", "device"],
    registers: [registry],
  });
  const meetQualitySamples = new Counter({
    name: "helix_meet_quality_samples_total",
    help: "Accepted bounded Meet quality samples.",
    registers: [registry],
  });
  const meetDegradedSamples = new Counter({
    name: "helix_meet_degraded_samples_total",
    help: "Meet quality samples crossing an operational degradation threshold.",
    labelNames: ["signal"],
    registers: [registry],
  });
  const meetJoinLatency = meetHistogram(
    registry,
    "join_latency_seconds",
    "Meet media join latency in seconds.",
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  );
  const meetCallDuration = meetHistogram(
    registry,
    "call_duration_seconds",
    "Participant duration derived from signed media join and leave events.",
    [5, 30, 60, 300, 900, 1800, 3600, 7200, 14400],
  );
  const meetPacketLoss = meetHistogram(
    registry,
    "packet_loss_percent",
    "Bounded WebRTC packet loss percentage.",
    [0.5, 1, 2, 5, 10, 25, 50, 100],
  );
  const meetJitter = meetHistogram(
    registry,
    "jitter_seconds",
    "Bounded WebRTC jitter in seconds.",
    [0.005, 0.01, 0.03, 0.05, 0.1, 0.25, 0.5, 1],
  );
  const meetRtt = meetHistogram(
    registry,
    "rtt_seconds",
    "Bounded WebRTC round-trip time in seconds.",
    [0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 2, 5],
  );
  const meetBitrate = meetHistogram(
    registry,
    "bitrate_kbps",
    "Bounded aggregate WebRTC bitrate in kilobits per second.",
    [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  );
  const meetConnectionQuality = meetHistogram(
    registry,
    "connection_quality_percent",
    "Jitsi connection quality score.",
    [10, 25, 50, 75, 90, 100],
  );
  const meetBridgeLoad = meetHistogram(
    registry,
    "bridge_load_percent",
    "Bounded Jitsi bridge load percentage reported with QoS.",
    [25, 50, 70, 85, 95, 100],
  );
  const meetBridgeParticipants = meetHistogram(
    registry,
    "bridge_participant_load",
    "Active participant load observed from signed media lifecycle events.",
    [1, 2, 5, 10, 25, 50, 75, 100, 250],
  );
  const securityScans = new Counter({
    name: "helix_security_scans_total",
    help: "Total terminal malware scan results by scanner and state.",
    labelNames: ["scanner", "state"],
    registers: [registry],
  });
  const securityScanDuration = new Histogram({
    name: "helix_security_scan_duration_seconds",
    help: "Malware scan duration in seconds by scanner and terminal state.",
    labelNames: ["scanner", "state"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  const securityScannedBytes = new Counter({
    name: "helix_security_scanned_bytes_total",
    help: "Total bytes submitted to malware scanners by scanner and terminal state.",
    labelNames: ["scanner", "state"],
    registers: [registry],
  });
  const securityScannerAvailable = new Gauge({
    name: "helix_security_scanner_available",
    help: "Whether the malware scanner is currently available (1) or unavailable (0).",
    labelNames: ["scanner"],
    registers: [registry],
  });
  const securityScanBacklog = new Gauge({
    name: "helix_security_scan_backlog_items",
    help: "Content items waiting for malware scanning.",
    labelNames: ["scanner"],
    registers: [registry],
  });
  const securityQuarantinedBytes = new Counter({
    name: "helix_security_quarantined_bytes_total",
    help: "Total bytes quarantined by malware scan policy.",
    labelNames: ["scanner"],
    registers: [registry],
  });

  return {
    registry,
    recordLLMChat(input) {
      const attemptLabels: LabelValues<"provider" | "model" | "feature" | "status"> = {
        provider: input.providerId,
        model: input.model,
        feature: input.feature,
        status: input.status,
      };
      llmCalls.inc(attemptLabels);
      llmLatency.observe(attemptLabels, input.durationSeconds);
      if (input.costCents !== undefined) {
        llmCost.inc(
          {
            provider: input.providerId,
            model: input.model,
            feature: input.feature,
          },
          Math.ceil(input.costCents * 10_000),
        );
      }
      if (input.status === "error") {
        llmErrors.inc({
          provider: input.providerId,
          model: input.model,
          feature: input.feature,
          error_type: input.errorType ?? "Error",
        });
      }
      if (input.fallback) {
        llmFallbacks.inc(attemptLabels);
      }
    },
    recordToolInvocation(input) {
      const labels: LabelValues<"tool_id" | "status"> = {
        tool_id: input.toolId,
        status: input.status,
      };
      toolInvocations.inc(labels);
      toolDuration.observe(labels, input.durationSeconds);
    },
    recordAgentToolLimiterDenial(input) {
      const labels: LabelValues<"tool_id" | "tier" | "actor_type" | "reason"> = {
        tool_id: input.toolId,
        tier: input.tier,
        actor_type: input.actorType,
        reason: input.reason,
      };
      agentToolLimiterDenials.inc(labels);
    },
    recordScimAuthFailure(input) {
      scimAuthFailures.inc({ reason: input.reason });
    },
    recordAgentOperationalControlDenial(input) {
      const labels: LabelValues<"tool_id" | "actor_type" | "reason"> = {
        tool_id: input.toolId,
        actor_type: input.actorType,
        reason: input.reason,
      };
      agentOperationalControlDenials.inc(labels);
    },
    recordToolPolicyDenial(input) {
      const labels: LabelValues<"tool_id" | "reason" | "request_channel" | "classification"> = {
        tool_id: input.toolId,
        reason: input.reason,
        request_channel: input.requestChannel,
        classification: input.effectiveClassification,
      };
      toolPolicyDenials.inc(labels);
    },
    recordSignupFunnelEvent(input) {
      const labels: LabelValues<"step" | "tier" | "plan_id" | "region"> = {
        step: input.step,
        tier: input.tier ?? "unknown",
        plan_id: input.planId ?? "unknown",
        region: input.region ?? "unknown",
      };
      signupFunnelEvents.inc(labels);
    },
    recordSignupActivationSlo(input) {
      const labels: LabelValues<"tier" | "plan_id" | "region" | "within_target"> = {
        tier: input.tier,
        plan_id: input.planId,
        region: input.region,
        within_target: input.withinTarget ? "true" : "false",
      };
      signupActivationDuration.observe(labels, input.durationSeconds);
    },
    recordPermissionCheck(input) {
      const labels: LabelValues<"policy" | "resource_type" | "action" | "actor_type" | "decision"> =
        {
          policy: input.policy,
          resource_type: input.resourceType,
          action: input.action,
          actor_type: input.actorType,
          decision: input.decision,
        };
      permissionChecks.inc(labels);
      permissionCheckDuration.observe(labels, input.durationSeconds);
    },
    recordAuditActivity(input) {
      const labels: LabelValues<"verb" | "object_type"> = {
        verb: input.verb,
        object_type: input.objectType,
      };
      auditActivity.inc(labels);
    },
    recordAuditHashChainVerification(input) {
      if (input.failedOrgCount > 0) {
        auditHashChainFailures.inc(input.failedOrgCount);
      }
      auditHashChainLastVerified.set(input.verifiedAtSeconds);
    },
    recordAuditShipping(input) {
      const labels: LabelValues<"destination"> = { destination: input.destination };
      auditShippingRecords.inc(labels, input.recordCount);
      auditShippingLag.set(labels, input.lagSeconds);
    },
    recordAuditShippingFailure(input) {
      auditShippingFailures.inc({ destination: input.destination });
    },
    setAuditShippingBacklog(input) {
      const labels: LabelValues<"destination"> = { destination: input.destination };
      auditShippingBacklog.set(labels, input.recordCount);
      auditShippingLag.set(labels, input.lagSeconds);
    },
    recordWebsocketConnectionOpened(input) {
      websocketConnectionsActive.inc({ route: input.route });
    },
    recordWebsocketConnectionClosed(input) {
      websocketConnectionsActive.dec({ route: input.route });
    },
    setStoragePoolSize(input) {
      storagePoolSize.set(input.size);
    },
    recordStoragePoolEviction() {
      storagePoolEvictions.inc();
    },
    recordSecurityScan(input) {
      const labels: LabelValues<"scanner" | "state"> = {
        scanner: input.scannerName,
        state: input.state,
      };
      securityScans.inc(labels);
      securityScanDuration.observe(labels, input.durationSeconds);
      securityScannedBytes.inc(labels, input.byteSize);
    },
    setSecurityScannerAvailable(input) {
      securityScannerAvailable.set({ scanner: input.scannerName }, input.available ? 1 : 0);
    },
    setSecurityScanBacklog(input) {
      securityScanBacklog.set({ scanner: input.scannerName }, input.pendingItems);
    },
    recordSecurityQuarantinedBytes(input) {
      securityQuarantinedBytes.inc({ scanner: input.scannerName }, input.byteSize);
    },
    recordMeetParticipantEvent(input) {
      meetParticipantEvents.inc({ event: input.event, device: input.device ?? "none" });
      observeBounded(meetCallDuration, input.durationSeconds, 7 * 24 * 60 * 60);
    },
    recordMeetQuality(input) {
      meetQualitySamples.inc();
      observeBounded(meetJoinLatency, input.joinLatencySeconds, 300);
      observeBounded(meetPacketLoss, input.packetLossPercent, 100);
      observeBounded(meetJitter, input.jitterSeconds, 10);
      observeBounded(meetRtt, input.rttSeconds, 60);
      observeBounded(meetBitrate, input.bitrateKbps, 1_000_000);
      observeBounded(meetConnectionQuality, input.connectionQuality, 100);
      observeBounded(meetBridgeLoad, input.bridgeLoadPercent, 100);
      observeBounded(meetBridgeParticipants, input.bridgeParticipantCount, 10_000);
      if ((input.packetLossPercent ?? 0) > 5) meetDegradedSamples.inc({ signal: "packet_loss" });
      if ((input.jitterSeconds ?? 0) > 0.1) meetDegradedSamples.inc({ signal: "jitter" });
      if ((input.rttSeconds ?? 0) > 0.4) meetDegradedSamples.inc({ signal: "rtt" });
      if (input.bitrateKbps !== undefined && input.bitrateKbps > 0 && input.bitrateKbps < 100) {
        meetDegradedSamples.inc({ signal: "bitrate" });
      }
      if ((input.bridgeLoadPercent ?? 0) > 85) {
        meetDegradedSamples.inc({ signal: "bridge_load" });
      }
    },
    recordSearchProjection(input) {
      searchProjectionLag.set({ indexer: input.indexerId }, input.lagSeconds);
      if (input.status === "error") searchProjectionErrors.inc({ indexer: input.indexerId });
    },
    recordOperationalEvent(input) {
      const labels = {
        capability: input.capability,
        operation: input.operation,
        status: input.status,
      };
      operationalEvents.inc(labels);
      observeBounded(operationalDuration, input.durationSeconds, 24 * 60 * 60, labels);
    },
    addOperationalUnits(input) {
      const value = input.value ?? 1;
      if (Number.isFinite(value) && value >= 0) {
        operationalUnits.inc({ capability: input.capability, measure: input.measure }, value);
      }
    },
    setOperationalState(input) {
      if (Number.isFinite(input.value)) {
        operationalState.set(
          { capability: input.capability, measure: input.measure },
          Math.max(0, input.value),
        );
      }
    },
  };
}

function meetHistogram(
  registry: Registry,
  name: string,
  help: string,
  buckets: readonly number[],
): Histogram {
  return new Histogram({
    name: `helix_meet_${name}`,
    help,
    buckets: [...buckets],
    registers: [registry],
  });
}

function observeBounded<T extends string>(
  histogram: Histogram<T>,
  value: number | undefined,
  maximum: number,
  labels?: LabelValues<T>,
): void {
  if (value !== undefined && Number.isFinite(value)) {
    const bounded = Math.max(0, Math.min(value, maximum));
    if (labels === undefined) histogram.observe(bounded);
    else histogram.observe(labels, bounded);
  }
}

export function installHttpMetrics(app: FastifyInstance, metrics: PlatformMetrics): void {
  const starts = new WeakMap<FastifyRequest, bigint>();
  const httpRequests = new Counter({
    name: "helix_http_requests_total",
    help: "Total HTTP requests served by the Helix platform.",
    labelNames: ["method", "route", "status_code"],
    registers: [metrics.registry],
  });
  const httpDuration = new Histogram({
    name: "helix_http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metrics.registry],
  });

  app.addHook("onRequest", async (request) => {
    starts.set(request, process.hrtime.bigint());
  });

  app.addHook("onResponse", async (request, reply) => {
    recordHttpRequest(request, reply, starts, httpRequests, httpDuration);
  });
}

export function durationSecondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000_000;
}

function recordHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  starts: WeakMap<FastifyRequest, bigint>,
  counter: Counter<"method" | "route" | "status_code">,
  duration: Histogram<"method" | "route" | "status_code">,
): void {
  const start = starts.get(request);
  if (start === undefined) {
    return;
  }

  const labels: LabelValues<"method" | "route" | "status_code"> = {
    method: request.method,
    route: routeLabel(request),
    status_code: String(reply.statusCode),
  };
  counter.inc(labels);
  duration.observe(labels, durationSecondsSince(start));
}

function routeLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown";
}
