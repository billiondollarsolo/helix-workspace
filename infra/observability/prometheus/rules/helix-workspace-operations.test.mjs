import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const rulesPath = join(
  repoRoot,
  "infra/observability/prometheus/rules/helix-workspace-operations.yml",
);
const dashboardPath = join(
  repoRoot,
  "plugins/com.helix.observability-grafana-stack/dashboards/workspace-operations.json",
);
const provisionedRulePaths = [
  join(repoRoot, "infra/observability/prometheus/rules/helix-agent-safety.yml"),
  join(repoRoot, "infra/observability/prometheus/rules/helix-signup-slo.yml"),
  rulesPath,
];
const forbiddenTelemetryField =
  /(?:^|[^a-z0-9_])(?:email|email_address|recipient|recipient_address|subject|message_body|body_text|filename|file_name|object_key|prompt|prompt_text|token|access_token|refresh_token|credential_id|tenant_name|org_name|org_slug)(?:$|[^a-z0-9_])/iu;
const requiredRunbookHeadings = [
  "## Detection",
  "## Containment",
  "## Diagnosis",
  "## Recovery",
  "## Verification",
  "## Rollback",
  "## Post-incident evidence",
];

async function loadAssets() {
  const [rulesSource, dashboardSource] = await Promise.all([
    readFile(rulesPath, "utf8"),
    readFile(dashboardPath, "utf8"),
  ]);

  return {
    alerts: parseAlertRules(rulesSource),
    dashboard: JSON.parse(dashboardSource),
  };
}

function parseAlertRules(source) {
  return source
    .split(/\n\s+- alert: /u)
    .slice(1)
    .map((block) => {
      const alert = block.match(/^([A-Za-z0-9]+)$/mu)?.[1];
      const expr = block.match(/^\s+expr:\s+(.+)$/mu)?.[1];
      const inlineLabels = block.match(/^\s+labels:\s+\{\s*(.+)\s*\}$/mu)?.[1];
      const annotations = Object.fromEntries(
        [...block.matchAll(/^\s{10}(runbook_url|resource_id|trace_query|summary):\s+(.+)$/gmu)].map(
          ([, key, value]) => [key, value],
        ),
      );

      if (alert === undefined || expr === undefined || inlineLabels === undefined) {
        throw new Error(`Unable to parse Workspace alert block: ${block.slice(0, 80)}`);
      }

      return {
        alert,
        expr,
        labels: Object.fromEntries(
          inlineLabels.split(",").map((entry) => {
            const [key, value] = entry.trim().split(/:\s+/u);
            return [key, value];
          }),
        ),
        annotations,
      };
    });
}

describe("Workspace operations observability assets", () => {
  it("covers every required Workspace operating domain", async () => {
    const { alerts, dashboard } = await loadAssets();
    const alertNames = alerts.map((rule) => rule.alert);
    const assetText = JSON.stringify({ alerts, dashboard });

    expect(alertNames).toEqual(
      expect.arrayContaining([
        "HelixHttpAvailabilityLow",
        "HelixHttpP95LatencyHigh",
        "HelixHttpErrorRateHigh",
        "HelixAuthFailureRateHigh",
        "HelixRateLimitDenialsSpike",
        "HelixDependencyUnavailable",
        "HelixDependencyTelemetryMissing",
        "HelixNodeFilesystemLowSpace",
        "HelixOutboxBacklogHigh",
        "HelixWorkerFailureRateHigh",
        "HelixMailReceiveLatencyHigh",
        "HelixMailProviderOutage",
        "HelixMailBounceComplaintSpike",
        "HelixMailSuppressionGrowthHigh",
        "HelixInboundMalwareSurge",
        "HelixMailQuarantineBacklogHigh",
        "HelixDriveUploadFailureRateHigh",
        "HelixDriveScannerUnavailable",
        "HelixDriveScanBacklogHigh",
        "HelixDriveQuarantinedBytesSpike",
        "HelixDriveInfectedVerdictSpike",
        "HelixObjectStoreUnavailable",
        "HelixObjectIntegrityMismatch",
        "HelixChatSocketTelemetryMissing",
        "HelixChatRealtimeDeliverySlow",
        "HelixChatReconnectSpike",
        "HelixChatRejectedFramesSpike",
        "HelixAgentCallFailureRateHigh",
        "HelixAgentApprovalBacklogHigh",
        "HelixAgentDeniedFailedSpike",
        "HelixAgentCostRateHigh",
        "HelixAgentOperationalControlDenials",
        "HelixAuditVerificationStale",
        "HelixAuditHashChainFailure",
        "HelixAuditShippingFailure",
        "HelixBackupStale",
        "HelixRestoreDrillStale",
        "HelixCertificateExpirySoon",
      ]),
    );

    for (const metric of [
      "helix_http_requests_total",
      "helix_http_request_duration_seconds_bucket",
      "helix_permission_checks_total",
      "helix_auth_rate_limit_decisions_total",
      "helix_dependency_up",
      "node_filesystem_avail_bytes",
      "node_filesystem_size_bytes",
      "helix_outbox_depth",
      "helix_outbox_oldest_age_seconds",
      "helix_worker_failures_total",
      "helix_mail_receive_duration_seconds_bucket",
      "helix_mail_send_duration_seconds_bucket",
      "helix_mail_delivery_events_total",
      "helix_mail_suppressions_active",
      "helix_drive_uploads_total",
      "helix_security_scan_backlog_items",
      "helix_security_scan_duration_seconds_bucket",
      "helix_security_scans_total",
      "helix_security_quarantined_bytes_total",
      "helix_websocket_connections_active",
      "helix_chat_publish_duration_seconds_bucket",
      "helix_chat_reconnects_total",
      "helix_chat_rejected_frames_total",
      "helix_llm_calls_total",
      "helix_agent_pending_approvals",
      "helix_tool_invocations_total",
      "helix_llm_cost_usd_micros_total",
      "helix_audit_hash_chain_last_verified_timestamp_seconds",
      "helix_audit_shipping_lag_seconds",
      "helix_backup_last_success_timestamp_seconds",
      "helix_restore_drill_last_success_timestamp_seconds",
    ]) {
      expect(assetText).toContain(metric);
    }

    expect(dashboard.uid).toBe("helix-workspace-operations");
    expect(dashboard.title).toBe("Helix Workspace Operations");
    expect(dashboard.panels).toHaveLength(20);
  });

  it("keeps alert and dashboard dimensions content-free", async () => {
    const { alerts, dashboard } = await loadAssets();

    for (const rule of alerts) {
      expect(Object.keys(rule.labels ?? {}).sort()).toEqual([
        "priority",
        "service",
        "severity",
        "slo",
      ]);
      expect(
        forbiddenTelemetryField.test(
          JSON.stringify({
            expr: rule.expr,
            labels: rule.labels,
            annotations: rule.annotations,
          }),
        ),
      ).toBe(false);
    }

    const dashboardTelemetry = JSON.stringify(
      dashboard.panels?.map((panel) => ({
        targets: panel.targets,
        title: panel.title,
      })),
    );
    expect(forbiddenTelemetryField.test(dashboardTelemetry)).toBe(false);
    expect(dashboard.templating?.list).toEqual([]);
  });

  it("links every alert to a complete focused runbook and safe correlation fields", async () => {
    const { alerts } = await loadAssets();
    const runbookPaths = new Set();

    for (const rule of alerts) {
      const annotations = rule.annotations ?? {};

      expect(typeof annotations.summary).toBe("string");
      expect(typeof annotations.resource_id).toBe("string");
      expect(typeof annotations.trace_query).toBe("string");
      expect(annotations.resource_id).not.toBe("");
      expect(annotations.trace_query).not.toBe("");
      expect(annotations.runbook_url).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/u);
      runbookPaths.add(String(annotations.runbook_url));
    }

    expect(runbookPaths.size).toBe(13);
    await Promise.all(
      [...runbookPaths].map(async (relativePath) => {
        const runbook = await readFile(join(repoRoot, relativePath), "utf8");

        for (const heading of requiredRunbookHeadings) {
          expect(runbook).toContain(heading);
        }
      }),
    );
  });

  it("keeps every provisioned alert linked, correlatable, and free of sensitive dimensions", async () => {
    const ruleSources = await Promise.all(
      provisionedRulePaths.map((rulePath) => readFile(rulePath, "utf8")),
    );
    const alertBlocks = ruleSources.flatMap((source) => source.split(/\n\s+- alert: /u).slice(1));

    expect(alertBlocks).toHaveLength(47);
    await Promise.all(
      alertBlocks.map(async (block) => {
        const expression = block.match(/^\s+expr:\s+(.+)$/mu)?.[1] ?? "";
        const labels = block.match(/^\s+labels:\s+(.+?)(?=^\s+annotations:)/msu)?.[1] ?? "";
        const runbookPath = block.match(/^\s+runbook_url:\s+(\S+)$/mu)?.[1];

        expect(block).toMatch(/^\s+resource_id:\s+\S+/mu);
        expect(block).toMatch(/^\s+trace_query:\s+.+/mu);
        expect(forbiddenTelemetryField.test(`${expression}\n${labels}`)).toBe(false);
        expect(runbookPath).toMatch(
          /^docs\/(?:runbooks|specs\/05-operations\/runbooks)\/[a-z0-9-]+\.md$/u,
        );

        const runbook = await readFile(join(repoRoot, String(runbookPath)), "utf8");
        for (const heading of requiredRunbookHeadings) {
          expect(runbook).toContain(heading);
        }
      }),
    );
  });

  it("provisions the dashboard and alert rule directories", async () => {
    const [prometheusConfig, pluginCompose, rootCompose] = await Promise.all([
      readFile(join(repoRoot, "infra/observability/prometheus/prometheus.yml"), "utf8"),
      readFile(
        join(repoRoot, "plugins/com.helix.observability-grafana-stack/compose.yaml"),
        "utf8",
      ),
      readFile(join(repoRoot, "docker-compose.yml"), "utf8"),
    ]);

    expect(prometheusConfig).toContain("/etc/prometheus/rules/*.yml");
    expect(pluginCompose).toContain("/etc/prometheus/rules:ro");
    expect(pluginCompose).toContain("/var/lib/grafana/dashboards/helix:ro");
    expect(rootCompose).toContain("/etc/prometheus/rules:ro");
    expect(rootCompose).toContain("/var/lib/grafana/dashboards/helix:ro");
  });
});
