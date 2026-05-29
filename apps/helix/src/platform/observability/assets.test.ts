import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPluginManifest } from "@helix/sdk";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = process.cwd().replace(/\/apps\/helix$/u, "");
const grafanaPluginRoot = join(repoRoot, "plugins/com.helix.observability-grafana-stack");
const otelPluginRoot = join(repoRoot, "plugins/com.helix.observability-otel");
const alertmanagerRoot = join(repoRoot, "infra/observability/alertmanager");
const prometheusRoot = join(repoRoot, "infra/observability/prometheus");
const rootComposePath = join(repoRoot, "docker-compose.yml");

const dashboardFiles = [
  "platform-overview.json",
  "mail.json",
  "chat.json",
  "drive.json",
  "docs.json",
  "ai.json",
  "signup.json",
  "agent.json",
  "security.json",
  "audit.json",
  "plugins.json",
  "tenant-overview.json",
  "tenant-finops.json",
] as const;

describe("observability plugin assets", () => {
  it("ships valid plugin manifests", async () => {
    for (const root of [otelPluginRoot, grafanaPluginRoot]) {
      const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8")) as unknown;
      expect(() => assertPluginManifest(manifest)).not.toThrow();
    }
  });

  it("ships parseable Grafana dashboards with stable uids and panels", async () => {
    const seenUids = new Set<string>();

    for (const file of dashboardFiles) {
      const dashboard = JSON.parse(
        await readFile(join(grafanaPluginRoot, "dashboards", file), "utf8"),
      ) as {
        readonly uid?: unknown;
        readonly title?: unknown;
        readonly panels?: unknown;
      };

      expect(typeof dashboard.uid).toBe("string");
      expect(typeof dashboard.title).toBe("string");
      expect(Array.isArray(dashboard.panels)).toBe(true);
      expect((dashboard.panels as readonly unknown[]).length).toBeGreaterThan(0);
      expect(seenUids.has(dashboard.uid as string)).toBe(false);
      seenUids.add(dashboard.uid as string);
    }
  });

  it("keeps the AI dashboard aligned with PRD observability dimensions", async () => {
    const panelText = await dashboardPanelText("ai.json");

    for (const expected of [
      "provider",
      "model",
      "feature",
      "helix_llm_cost_usd_micros_total",
      "helix_llm_errors_total",
      "helix_llm_latency_seconds_bucket",
      "helix_llm_routing_fallback_total",
    ]) {
      expect(panelText).toContain(expected);
    }
  });

  it("keeps the audit dashboard aligned with PRD audit operations", async () => {
    const panelText = await dashboardPanelText("audit.json");

    for (const expected of [
      "Activity rate",
      "Hash-chain verification failures",
      "Latest hash-chain verification",
      "Shipping lag",
      "Immutable shipping backlog",
      "helix_audit_activity_total",
      "helix_audit_hash_chain_failures_total",
      "helix_audit_hash_chain_last_verified_timestamp_seconds",
      "helix_audit_shipping_lag_seconds",
      "helix_audit_shipping_backlog_records",
    ]) {
      expect(panelText).toContain(expected);
    }
  });

  it("keeps the signup dashboard aligned with signup funnel and activation SLO metrics", async () => {
    const panelText = await dashboardPanelText("signup.json");

    for (const expected of [
      "Signup funnel event rate",
      "Signup activation p95",
      "Signup activation SLO misses",
      "helix_signup_funnel_events_total",
      "helix_signup_activation_duration_seconds_bucket",
      "helix_signup_activation_duration_seconds_count",
      "histogram_quantile",
      "within_target",
      "plan_id",
      "helix-prometheus",
    ]) {
      expect(panelText).toContain(expected);
    }
  });

  it("ships signup activation SLO alert rules with low-cardinality labels", async () => {
    const prometheusConfig = YAML.parse(
      await readFile(join(prometheusRoot, "prometheus.yml"), "utf8"),
    ) as {
      readonly rule_files?: readonly unknown[];
      readonly alerting?: {
        readonly alertmanagers?: readonly {
          readonly static_configs?: readonly {
            readonly targets?: readonly unknown[];
          }[];
        }[];
      };
    };
    const ruleFile = await readFile(join(prometheusRoot, "rules/helix-signup-slo.yml"), "utf8");
    const rules = YAML.parse(ruleFile) as {
      readonly groups?: readonly {
        readonly rules?: readonly {
          readonly alert?: unknown;
          readonly expr?: unknown;
          readonly labels?: Record<string, unknown>;
        }[];
      }[];
    };
    const pluginCompose = await readFile(join(grafanaPluginRoot, "compose.yaml"), "utf8");
    const rootCompose = await readFile(rootComposePath, "utf8");

    expect(prometheusConfig.rule_files).toContain("/etc/prometheus/rules/*.yml");
    expect(
      prometheusConfig.alerting?.alertmanagers?.flatMap(
        (manager) => manager.static_configs?.flatMap((config) => config.targets ?? []) ?? [],
      ),
    ).toContain("alertmanager:9093");
    expect(pluginCompose).toContain(
      "../../infra/observability/prometheus/rules:/etc/prometheus/rules:ro",
    );
    expect(rootCompose).toContain(
      "./infra/observability/prometheus/rules:/etc/prometheus/rules:ro",
    );

    const alertRules = rules.groups?.flatMap((group) => group.rules ?? []) ?? [];
    expect(alertRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alert: "HelixSignupActivationP95High" }),
        expect.objectContaining({ alert: "HelixSignupActivationSloMissRateHigh" }),
        expect.objectContaining({ alert: "HelixSignupActivationSamplesMissing" }),
      ]),
    );

    const ruleText = JSON.stringify(alertRules);
    for (const expected of [
      "helix_signup_funnel_events_total",
      "helix_signup_activation_duration_seconds_bucket",
      "helix_signup_activation_duration_seconds_count",
      "tier",
      "plan_id",
      "region",
      "within_target",
      "priority",
      "p2",
      "signup_activation",
      "runbook_url",
      "docs/specs/05-operations/runbooks/signup-activation-slo-breach.md",
    ]) {
      expect(ruleText).toContain(expected);
    }
    for (const forbidden of [
      "org_id",
      "org_slug",
      "actor_id",
      "email",
      "token",
      "$labels.ip",
      'ip="',
      "user_agent",
    ]) {
      expect(ruleText).not.toContain(forbidden);
    }
  });

  it("ships bundled Alertmanager routing proof for signup activation SLO alerts", async () => {
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
    const pluginCompose = await readFile(join(grafanaPluginRoot, "compose.yaml"), "utf8");
    const rootCompose = await readFile(rootComposePath, "utf8");

    expect(rootCompose).toContain("alertmanager:");
    expect(rootCompose).toContain(
      "./infra/observability/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro",
    );
    expect(pluginCompose).toContain("alertmanager:");
    expect(pluginCompose).toContain(
      "../../infra/observability/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro",
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
    expect(alertmanager.route?.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receiver: "helix-signup-slo-webhook",
          matchers: expect.arrayContaining(['service="signup"', 'slo="signup_activation"']),
        }),
      ]),
    );
    expect(alertmanager.receivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "helix-signup-slo-webhook",
          webhook_configs: expect.arrayContaining([
            expect.objectContaining({
              url: "http://host.docker.internal:28462/alertmanager/signup",
              send_resolved: true,
            }),
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(alertmanager)).not.toContain("helix-signup-slo-paging");
    expect(productionAlertmanager.route?.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receiver: "helix-signup-slo-webhook",
          matchers: expect.arrayContaining(['service="signup"', 'slo="signup_activation"']),
          continue: true,
        }),
        expect.objectContaining({
          receiver: "helix-signup-slo-paging",
          matchers: expect.arrayContaining(['service="signup"', 'slo="signup_activation"']),
        }),
      ]),
    );
    expect(productionAlertmanager.receivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "helix-signup-slo-paging",
          webhook_configs: expect.arrayContaining([
            expect.objectContaining({
              url_file: "/etc/alertmanager/secrets/signup-slo-paging-webhook-url",
              send_resolved: true,
            }),
          ]),
        }),
      ]),
    );

    const alertmanagerText = `${JSON.stringify(alertmanager)}\n${JSON.stringify(productionAlertmanager)}`;
    for (const forbidden of ["org_id", "actor_id", "email", "token", "user_agent", "ip_address"]) {
      expect(alertmanagerText).not.toContain(forbidden);
    }
  });

  it("ships per-tenant dashboards with an org_id template variable", async () => {
    for (const file of ["tenant-overview.json", "tenant-finops.json"] as const) {
      const dashboard = await readDashboard(file);
      const variables =
        isRecord(dashboard) && isRecord(dashboard.templating)
          ? dashboard.templating.list
          : undefined;

      expect(Array.isArray(variables)).toBe(true);
      expect(variables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "org_id",
            type: "textbox",
          }),
        ]),
      );

      const panelText = await dashboardPanelText(file);
      expect(panelText).toContain('org_id="$org_id"');
      expect(panelText).toContain("helix-prometheus");
    }
  });

  it("provisions dashboards and datasources for the bundled Grafana stack", async () => {
    const dashboardsProvider = await readFile(
      join(grafanaPluginRoot, "provisioning/dashboards/helix.yml"),
      "utf8",
    );
    const datasources = await readFile(
      join(grafanaPluginRoot, "provisioning/datasources/helix.yml"),
      "utf8",
    );

    expect(dashboardsProvider).toContain("/var/lib/grafana/dashboards/helix");
    expect(datasources).toContain("helix-prometheus");
    expect(datasources).toContain("helix-tempo");
    expect(datasources).toContain("helix-loki");
  });
});

async function dashboardPanelText(file: string): Promise<string> {
  const dashboard = await readDashboard(file);
  const panels = isRecord(dashboard) && Array.isArray(dashboard.panels) ? dashboard.panels : [];
  const panelTextParts: string[] = [];
  for (const panel of panels) {
    if (!isRecord(panel)) {
      continue;
    }
    if (typeof panel.title === "string") {
      panelTextParts.push(panel.title);
    }
    if (isRecord(panel.datasource) && typeof panel.datasource.uid === "string") {
      panelTextParts.push(panel.datasource.uid);
    }
    if (!Array.isArray(panel.targets)) {
      continue;
    }
    for (const target of panel.targets) {
      if (isRecord(target) && typeof target.expr === "string") {
        panelTextParts.push(target.expr);
      }
      if (isRecord(target) && typeof target.query === "string") {
        panelTextParts.push(target.query);
      }
    }
  }
  return panelTextParts.join("\n");
}

async function readDashboard(file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(grafanaPluginRoot, "dashboards", file), "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
