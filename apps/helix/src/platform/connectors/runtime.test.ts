import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "@helix/sdk";
import { discoverPluginById } from "../plugins/loader.js";
import { loadConnectors, type ConnectorLoadResult } from "./runtime.js";

const tempDirs: string[] = [];
const runtimes: ConnectorLoadResult[] = [];
const bundledPluginsDir = fileURLToPath(new URL("../../../../../plugins", import.meta.url));

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function load(options: Parameters<typeof loadConnectors>[0]): Promise<ConnectorLoadResult> {
  const result = await loadConnectors(options);
  runtimes.push(result);
  return result;
}

async function writeConnectorDir(
  id: string,
  manifest: Partial<PluginManifest> & { category?: string },
  indexJs: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "helix-connectors-"));
  tempDirs.push(root);
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const fullManifest = {
    id,
    name: id,
    version: "1.0.0",
    sdkVersion: "^1.0.0",
    kind: "sandboxed",
    main: "index.js",
    capabilities: { provides: [], consumes: [] },
    permissions: { scopes: [], "outbound-network": [], filesystem: [], envVars: [] },
    ...manifest,
  };
  await writeFile(join(dir, "plugin.json"), JSON.stringify(fullManifest, null, 2));
  await writeFile(join(dir, "index.js"), indexJs);
  return root;
}

describe("connector runtime", () => {
  it("loads a connector-category plugin and runs its register hook", async () => {
    const pluginsDir = await writeConnectorDir(
      "com.example.test-connector",
      { category: "connector" },
      `export default {
         id: "com.example.test-connector",
         register(sink) {
           sink.registerWebhookFormat({
             id: "test-format",
             render: () => ({ contentType: "application/json", body: { ok: true } }),
           });
         },
       };`,
    );

    const result = await load({ pluginsDir });

    expect(result.loaded.map((connector) => connector.manifest.id)).toEqual([
      "com.example.test-connector",
    ]);
    const format = result.registry.getWebhookFormat("test-format");
    expect(format).toBeDefined();
    expect(
      await format?.render({
        deliveryId: "d1",
        subject: "test.event",
        createdAt: new Date(),
        payload: {},
      }),
    ).toEqual({ contentType: "application/json", body: { ok: true } });
  });

  it("isolates malformed artifacts and commits runtime hooks atomically", async () => {
    const errors: string[] = [];
    const pluginsDir = await writeConnectorDir(
      "com.example.healthy",
      { category: "connector" },
      `export default {
         register(sink) {
           sink.registerWebhookFormat({
             id: "healthy-format",
             render: () => ({ contentType: "application/json", body: {} }),
           });
         },
       };`,
    );
    const brokenDir = join(pluginsDir, "com.example.broken-manifest");
    await mkdir(brokenDir);
    await writeFile(join(brokenDir, "plugin.json"), "{broken");

    const result = await load({
      pluginsDir,
      enabledPluginIds: new Set(["com.example.healthy"]),
      onConnectorError: (_error, manifest) => errors.push(manifest.id),
    });
    expect(result.loaded.map((connector) => connector.manifest.id)).toEqual([
      "com.example.healthy",
    ]);
    expect(errors).toEqual(["com.example.broken-manifest"]);

    result.disable("com.example.healthy");
    const plugin = await discoverPluginById(pluginsDir, "com.example.healthy");
    const staged = await result.prepare(plugin);
    expect(result.registry.getWebhookFormat("healthy-format")).toBeUndefined();
    staged?.commit();
    expect(result.registry.getWebhookFormat("healthy-format")).toBeDefined();
    result.disable("com.example.healthy");
    expect(result.registry.getWebhookFormat("healthy-format")).toBeUndefined();
  });

  it("keeps the active version when an upgrade fails its start check", async () => {
    const pluginsDir = await writeConnectorDir(
      "com.example.upgrade",
      { category: "connector" },
      `export default {
         register(sink) {
           sink.registerWebhookFormat({
             id: "stable-format",
             render: () => ({ contentType: "application/json", body: { version: 1 } }),
           });
         },
       };`,
    );
    const result = await load({ pluginsDir });
    const pluginDir = join(pluginsDir, "com.example.upgrade");
    const manifest = JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ ...manifest, version: "2.0.0" }),
    );
    await writeFile(join(pluginDir, "index.js"), "export default {};\n");
    const upgrade = await discoverPluginById(pluginsDir, "com.example.upgrade");

    await expect(result.prepare(upgrade)).rejects.toThrow();
    expect(result.loaded[0]?.manifest.version).toBe("1.0.0");
    expect(result.registry.getWebhookFormat("stable-format")).toBeDefined();
  });

  it("skips core-app and uncategorized plugins", async () => {
    const pluginsDir = await writeConnectorDir(
      "com.example.core-app",
      { category: "core-app" },
      `export default { register() {} };`,
    );

    const result = await load({ pluginsDir });
    expect(result.loaded).toHaveLength(0);
  });

  it("rejects empty connector modules", async () => {
    const errors: string[] = [];
    const pluginsDir = await writeConnectorDir(
      "com.example.empty",
      { category: "connector" },
      `export default {};`,
    );

    const result = await load({
      pluginsDir,
      onConnectorError: (_error, manifest) => errors.push(manifest.id),
    });

    expect(result.loaded).toHaveLength(0);
    expect(errors).toEqual(["com.example.empty"]);
  });

  it("reports an error for a connector with a broken entry point", async () => {
    const errors: string[] = [];
    const pluginsDir = await writeConnectorDir(
      "com.example.broken",
      { category: "connector" },
      `export default { notARegisterFunction: true };`,
    );

    const result = await load({
      pluginsDir,
      onConnectorError: (_error, manifest) => errors.push(manifest.id),
    });

    expect(result.loaded).toHaveLength(0);
    expect(errors).toEqual(["com.example.broken"]);
  });

  it("loads the bundled Slack outbound-webhook connector", async () => {
    const result = await load({ pluginsDir: bundledPluginsDir });

    expect(result.loaded.map((connector) => connector.manifest.id)).toEqual([
      "com.helix.webhook-out-slack",
    ]);
    expect(result.registry.getWebhookFormat("slack")).toBeDefined();

    const rendered = await result.registry.getWebhookFormat("slack")?.render({
      deliveryId: "d1",
      subject: "mail.received",
      createdAt: new Date(),
      payload: { subject: "Hello there" },
    });
    expect(rendered?.contentType).toBe("application/json");
    expect(JSON.stringify(rendered?.body)).toContain("Hello there");
  });

  it("denies connector filesystem, environment, network, process, and worker authority", async () => {
    const pluginsDir = await writeConnectorDir(
      "com.example.untrusted",
      { category: "connector" },
      `export default {
         id: "com.example.untrusted",
         async register(sink) {
           const denied = { environment: typeof process === "undefined" };
           for (const [name, module] of [["filesystem", "node:fs"], ["process", "node:child_process"], ["worker", "node:worker_threads"]]) {
             try { await import(module); denied[name] = false; } catch { denied[name] = true; }
           }
           try { await fetch("https://example.com"); denied.network = false; } catch { denied.network = true; }
           sink.registerWebhookFormat({
             id: "authority-check",
             render: () => ({ contentType: "application/json", body: denied }),
           });
         },
       };`,
    );

    const result = await load({ pluginsDir });
    const rendered = await result.registry.getWebhookFormat("authority-check")?.render({
      deliveryId: "d1",
      subject: "test.event",
      createdAt: new Date(),
      payload: {},
    });

    expect(rendered?.body).toEqual({
      environment: true,
      filesystem: true,
      network: true,
      process: true,
      worker: true,
    });
  });

  it("kills a connector that exceeds its CPU deadline", async () => {
    const errors: string[] = [];
    const pluginsDir = await writeConnectorDir(
      "com.example.runaway",
      { category: "connector" },
      `export default { register() { while (true) {} } };`,
    );

    const result = await load({
      pluginsDir,
      onConnectorError: (error) => errors.push(error instanceof Error ? error.message : "error"),
    });

    expect(result.loaded).toHaveLength(0);
    expect(errors).toEqual(["Connector sandbox timed out."]);
  });
});
