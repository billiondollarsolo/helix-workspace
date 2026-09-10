import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = process.cwd().replace(/\/apps\/helix$/u, "");
const alertmanagerRoot = join(repoRoot, "infra/observability/alertmanager");
const grafanaRoot = join(repoRoot, "infra/observability/grafana/dashboards");
const observabilityRoot = join(repoRoot, "infra/observability");
const rootComposePath = join(repoRoot, "docker-compose.yml");

describe("observability infrastructure assets", () => {
  it("keeps capability dashboards and alerts on metrics with real producers", async () => {
    const dashboard = JSON.parse(
      await readFile(join(grafanaRoot, "capability-health.json"), "utf8"),
    ) as unknown;
    const dashboardText = JSON.stringify(dashboard);
    const metricDefinitions = await readFile(
      join(repoRoot, "apps/helix/src/api/metrics.ts"),
      "utf8",
    );
    const producerText = await Promise.all(
      [
        "apps/helix/src/platform/mail/outbound.ts",
        "apps/helix/src/platform/chat/realtime.ts",
        "apps/helix/src/platform/drive/store/quotas.ts",
        "apps/helix/src/platform/drive/store/storage.ts",
        "apps/helix/src/platform/drive/store/uploads.ts",
        "apps/helix/src/bootstrap/storage.ts",
        "apps/helix/src/bootstrap/search-runtime.ts",
      ].map((file) => readFile(join(repoRoot, file), "utf8")),
    ).then((files) => files.join("\n"));
    const alerts = await readFile(
      join(repoRoot, "infra/helm/helix/files/helix-capability-health.yml"),
      "utf8",
    );

    for (const metric of [
      "helix_http_requests_total",
      "helix_http_request_duration_seconds",
      "helix_tool_invocations_total",
      "helix_tool_invocation_duration_seconds",
      "helix_operational_events_total",
      "helix_operational_duration_seconds",
      "helix_operational_units_total",
      "helix_operational_state",
      "helix_search_projection_lag_seconds",
      "helix_meet_degraded_samples_total",
      "helix_permission_checks_total",
      "helix_audit_hash_chain_failures_total",
    ]) {
      expect(dashboardText).toContain(metric);
      expect(metricDefinitions).toContain(`name: "${metric}"`);
    }
    for (const expectedProducer of [
      'operation: "queue_wait"',
      'operation: "delivery"',
      'this.record("fanout"',
      'this.record("replay"',
      'operation: "virus_scan"',
      'operation: "quota"',
      'operation: "download"',
      'measure: "drift_objects"',
    ]) {
      expect(producerText).toContain(expectedProducer);
    }
    for (const alert of [
      "HelixOperationalFailure",
      "HelixMailDeliveryFailure",
      "HelixSearchReconciliationDrift",
    ]) {
      expect(alerts).toContain(alert);
    }
    expect(`${dashboardText}\n${alerts}`).not.toMatch(
      /org_id|actor_id|email_address|user_agent|ip_address/u,
    );
  });

  it("routes production product SLO alerts to the configured paging secret", async () => {
    const alertmanager = YAML.parse(
      await readFile(join(alertmanagerRoot, "alertmanager.yml"), "utf8"),
    ) as {
      readonly route?: {
        readonly group_by?: readonly unknown[];
        readonly routes?: readonly {
          readonly receiver?: unknown;
          readonly matchers?: readonly unknown[];
        }[];
      };
      readonly receivers?: readonly {
        readonly name?: unknown;
        readonly webhook_configs?: readonly {
          readonly url?: unknown;
          readonly url_file?: unknown;
          readonly send_resolved?: unknown;
        }[];
      }[];
    };
    const productionAlertmanager = YAML.parse(
      await readFile(join(alertmanagerRoot, "alertmanager.production.yml"), "utf8"),
    ) as {
      readonly route?: {
        readonly routes?: readonly {
          readonly receiver?: unknown;
          readonly matchers?: readonly unknown[];
          readonly continue?: unknown;
        }[];
      };
      readonly receivers?: readonly {
        readonly name?: unknown;
        readonly webhook_configs?: readonly {
          readonly url?: unknown;
          readonly url_file?: unknown;
          readonly send_resolved?: unknown;
        }[];
      }[];
    };
    const rootCompose = await readFile(rootComposePath, "utf8");

    expect(rootCompose).toContain("alertmanager:");
    expect(rootCompose).toContain(
      "./infra/observability/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro",
    );
    expect(alertmanager.route?.group_by).toEqual(
      expect.arrayContaining([
        "alertname",
        "severity",
        "priority",
        "service",
        "slo",
        "tier",
        "plan_id",
        "region",
      ]),
    );
    const productionPagingRoute = productionAlertmanager.route?.routes?.find(
      (route) => route.receiver === "helix-product-slo-paging",
    );
    expect(productionPagingRoute?.matchers).toEqual(
      expect.arrayContaining(['slo=~"product_availability|availability|freshness|healthy_media"']),
    );
    const productionPagingReceiver = productionAlertmanager.receivers?.find(
      (receiver) => receiver.name === "helix-product-slo-paging",
    );
    expect(productionPagingReceiver?.webhook_configs).toContainEqual({
      url_file: "/etc/alertmanager/secrets/product-slo-paging-webhook-url",
      send_resolved: true,
    });

    const alertmanagerText = `${JSON.stringify(alertmanager)}\n${JSON.stringify(productionAlertmanager)}`;
    for (const forbidden of ["org_id", "actor_id", "email", "token", "user_agent", "ip_address"]) {
      expect(alertmanagerText).not.toContain(forbidden);
    }
  });

  it("ships a fail-closed production telemetry profile", async () => {
    const [
      collectorText,
      lokiText,
      tempoText,
      datasourcesText,
      grafanaText,
      contractText,
      networkText,
    ] = await Promise.all([
      readFile(join(observabilityRoot, "otel-collector/config.production.yaml"), "utf8"),
      readFile(join(observabilityRoot, "loki/loki.production.yaml"), "utf8"),
      readFile(join(observabilityRoot, "tempo/tempo.production.yaml"), "utf8"),
      readFile(
        join(observabilityRoot, "grafana/provisioning/datasources/datasources.production.yml"),
        "utf8",
      ),
      readFile(join(observabilityRoot, "grafana/grafana.production.ini"), "utf8"),
      readFile(join(observabilityRoot, "production/deployment-contract.yml"), "utf8"),
      readFile(join(observabilityRoot, "production/network-policies.yml"), "utf8"),
    ]);
    const collector = YAML.parse(collectorText) as Record<string, unknown>;
    const loki = YAML.parse(lokiText) as Record<string, unknown>;
    const tempo = YAML.parse(tempoText) as Record<string, unknown>;
    const datasources = YAML.parse(datasourcesText) as {
      readonly datasources: readonly { readonly url?: string; readonly jsonData?: unknown }[];
    };
    const contract = YAML.parse(contractText) as {
      readonly spec: {
        readonly availability: Record<string, unknown>;
        readonly storage: {
          readonly retentionHours: number;
          readonly buckets: readonly Record<string, unknown>[];
        };
        readonly workloadIdentity: Record<string, unknown>;
      };
    };
    const policies = YAML.parseAllDocuments(networkText).map((document) => document.toJS()) as {
      readonly metadata?: { readonly name?: string };
      readonly spec?: { readonly policyTypes?: readonly string[] };
    }[];

    expect(collector).toHaveProperty("receivers.otlp.protocols.http.tls.client_ca_file");
    expect(collector).toHaveProperty("processors.memory_limiter");
    expect(collector).toHaveProperty("processors.filter/tenant");
    expect(collectorText).toContain("X-Scope-OrgID: ${env:HELIX_OBSERVABILITY_TENANT_ID}");
    for (const secretAttribute of [
      "authorization",
      "cookie",
      "user.email",
      "message.body",
      "file.name",
      "gen_ai.prompt",
      "token",
    ]) {
      expect(collectorText).toContain(secretAttribute);
    }

    expect(loki.auth_enabled).toBe(true);
    expect(loki).toHaveProperty("common.replication_factor", 3);
    expect(loki).toHaveProperty("common.storage.s3");
    expect(loki).toHaveProperty("compactor.retention_enabled", true);
    expect(loki).toHaveProperty("limits_config.retention_period", "720h");
    expect(loki).toHaveProperty("limits_config.max_global_streams_per_user", 10000);
    expect(loki).toHaveProperty(
      "server.http_tls_config.client_auth_type",
      "RequireAndVerifyClientCert",
    );

    expect(tempo.multitenancy_enabled).toBe(true);
    expect(tempo).toHaveProperty("ingest.kafka.auto_create_topic_enabled", false);
    expect(tempo).toHaveProperty("live_store.partition_ring.min_partition_owners_count", 3);
    expect(tempo).toHaveProperty("storage.trace.backend", "s3");
    expect(tempo).toHaveProperty(
      "backend_scheduler.provider.compaction.compaction.block_retention",
      "720h",
    );
    expect(tempo).toHaveProperty(
      "server.http_tls_config.client_auth_type",
      "RequireAndVerifyClientCert",
    );
    expect(tempo).toHaveProperty("query_frontend.log_query_request_headers", "X-Scope-OrgID");

    expect(datasources.datasources).toHaveLength(2);
    for (const datasource of datasources.datasources) {
      expect(datasource.url).toMatch(/^https:\/\//u);
      expect(datasource.jsonData).toMatchObject({
        httpHeaderName1: "X-Scope-OrgID",
        tlsAuth: true,
        tlsAuthWithCACert: true,
      });
    }
    expect(grafanaText).toContain("enabled = false");
    expect(grafanaText).toContain("router_logging = true");

    expect(contract.spec.workloadIdentity).toMatchObject({
      mode: "mutual-tls",
      internalTransport: "service-mesh-strict-mtls",
      unauthorizedIngestResult: "tls-handshake-failure",
      unauthorizedQueryResult: "tls-handshake-failure",
    });
    expect(contract.spec.availability).toMatchObject({
      lokiReplicas: 3,
      tempoDistributorReplicas: 3,
      tempoKafkaReplicas: 3,
      tempoKafkaReplicationFactor: 3,
      tempoKafkaMinimumInSyncReplicas: 2,
      tempoPartitionConsumers: 3,
      collectorReplicas: 3,
      spreadAcrossZones: true,
      walPersistentVolume: true,
      kafkaTransport: "service-mesh-strict-mtls",
    });
    expect(contract.spec.storage.retentionHours).toBe(720);
    expect(contract.spec.storage.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ versioning: "Enabled", replication: "required" }),
      ]),
    );
    expect(
      policies.find((policy) => policy.metadata?.name === "observability-default-deny")?.spec,
    ).toMatchObject({ policyTypes: ["Ingress", "Egress"] });
  });
});
