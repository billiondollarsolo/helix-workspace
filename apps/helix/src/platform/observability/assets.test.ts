import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPluginManifest } from "@helix/sdk";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd().replace(/\/apps\/helix$/u, "");
const grafanaPluginRoot = join(repoRoot, "plugins/com.helix.observability-grafana-stack");
const otelPluginRoot = join(repoRoot, "plugins/com.helix.observability-otel");

const dashboardFiles = [
  "platform-overview.json",
  "mail.json",
  "chat.json",
  "drive.json",
  "docs.json",
  "ai.json",
  "agent.json",
  "security.json",
  "audit.json",
  "plugins.json",
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
    expect(panelText).not.toContain("actor_id");
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
  const dashboard = JSON.parse(
    await readFile(join(grafanaPluginRoot, "dashboards", file), "utf8"),
  ) as unknown;
  const panels = isRecord(dashboard) && Array.isArray(dashboard.panels) ? dashboard.panels : [];
  const panelTextParts: string[] = [];
  for (const panel of panels) {
    if (!isRecord(panel)) {
      continue;
    }
    if (typeof panel.title === "string") {
      panelTextParts.push(panel.title);
    }
    if (!Array.isArray(panel.targets)) {
      continue;
    }
    for (const target of panel.targets) {
      if (isRecord(target) && typeof target.expr === "string") {
        panelTextParts.push(target.expr);
      }
    }
  }
  return panelTextParts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
