import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "@helix/sdk";
import { loadConnectors } from "./runtime.js";

const tempDirs: string[] = [];
const bundledPluginsDir = fileURLToPath(new URL("../../../../../plugins", import.meta.url));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

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
    kind: "in-process",
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

    const result = await loadConnectors({ pluginsDir });

    expect(result.loaded.map((connector) => connector.manifest.id)).toEqual([
      "com.example.test-connector",
    ]);
    const format = result.registry.getWebhookFormat("test-format");
    expect(format).toBeDefined();
    expect(
      format?.render({
        deliveryId: "d1",
        subject: "test.event",
        createdAt: new Date(),
        payload: {},
      }),
    ).toEqual({ contentType: "application/json", body: { ok: true } });
  });

  it("skips core-app and uncategorized plugins", async () => {
    const pluginsDir = await writeConnectorDir(
      "com.example.core-app",
      { category: "core-app" },
      `export default { register() {} };`,
    );

    const result = await loadConnectors({ pluginsDir });
    expect(result.loaded).toHaveLength(0);
  });

  it("skips an unrealized connector scaffold without erroring", async () => {
    const skipped: string[] = [];
    const errors: string[] = [];
    const pluginsDir = await writeConnectorDir(
      "com.example.scaffold",
      { category: "connector" },
      `export default {};`,
    );

    const result = await loadConnectors({
      pluginsDir,
      onConnectorSkipped: (manifest) => skipped.push(manifest.id),
      onConnectorError: (_error, manifest) => errors.push(manifest.id),
    });

    expect(result.loaded).toHaveLength(0);
    expect(skipped).toEqual(["com.example.scaffold"]);
    expect(errors).toHaveLength(0);
  });

  it("reports an error for a connector with a broken entry point", async () => {
    const errors: string[] = [];
    const pluginsDir = await writeConnectorDir(
      "com.example.broken",
      { category: "connector" },
      `export default { notARegisterFunction: true };`,
    );

    const result = await loadConnectors({
      pluginsDir,
      onConnectorError: (_error, manifest) => errors.push(manifest.id),
    });

    expect(result.loaded).toHaveLength(0);
    expect(errors).toEqual(["com.example.broken"]);
  });

  it("loads the bundled Slack outbound-webhook connector", async () => {
    const result = await loadConnectors({ pluginsDir: bundledPluginsDir });

    const slack = result.loaded.find(
      (connector) => connector.manifest.id === "com.helix.webhook-out-slack",
    );
    expect(slack).toBeDefined();
    expect(result.registry.getWebhookFormat("slack")).toBeDefined();

    const rendered = result.registry.getWebhookFormat("slack")?.render({
      deliveryId: "d1",
      subject: "mail.received",
      createdAt: new Date(),
      payload: { subject: "Hello there" },
    });
    expect(rendered?.contentType).toBe("application/json");
    expect(JSON.stringify(rendered?.body)).toContain("Hello there");
  });
});
