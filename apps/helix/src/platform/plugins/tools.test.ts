import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, PluginManifest } from "@helix/sdk-types";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { createToolRegistry } from "../tool-registry.js";
import { calculatePluginBundleDigest, discoverPlugin } from "./loader.js";
import {
  InMemoryPluginLifecycleStore,
  PluginLifecycle,
  registerPluginTools,
  type PluginRuntimeLifecycle,
} from "./tools.js";
import {
  pluginCatalogPayloadBytes,
  type PluginCatalogEntry,
  type PluginCatalogPayload,
  type PluginTrustOptions,
} from "./trust.js";

const tempDirs: string[] = [];
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Admin",
  scopes: ["admin.plugins"],
};

describe("plugin tools", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("registers the plugin list and install tool surface", () => {
    const registry = createToolRegistry();
    registerPluginTools(registry, { pluginsDir: "/tmp/helix-missing-plugins" });

    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("plugin."))
        .map((tool) => tool.id),
    ).toEqual([
      "plugin.disable",
      "plugin.enable",
      "plugin.install",
      "plugin.list",
      "plugin.uninstall",
    ]);
  });

  it("lists plugin manifests with permissions and confirmation metadata", async () => {
    const pluginsDir = await writePluginsDirectory([
      {
        id: "com.example.official",
        permissions: {
          scopes: ["drive.write"],
          "outbound-network": [],
          filesystem: [],
          envVars: [],
        },
      },
      {
        id: "com.example.community",
        permissions: {
          scopes: ["drive.write"],
          "outbound-network": ["api.example.com"],
          filesystem: ["/tmp/imports"],
          envVars: ["EXAMPLE_API_KEY"],
        },
      },
    ]);
    const registry = createToolRegistry();
    registerPluginTools(registry, {
      pluginsDir,
      discovery: { pluginTrust: await createPluginTrust(pluginsDir, ["com.example.official"]) },
    });

    const result = await registry.invoke("plugin.list", {}, { actor });

    expect(result.ok).toBe(true);
    const output = result.ok ? (result.output as PluginListOutput) : undefined;
    const community = output?.plugins.find((plugin) => plugin.id === "com.example.community");
    const official = output?.plugins.find((plugin) => plugin.id === "com.example.official");

    expect(community?.install.confirmationRequired).toBe(true);
    expect(community?.install.confirmations.map((confirmation) => confirmation.id)).toEqual([
      "source.non_official",
      "permissions.scopes.drive.write",
      "permissions.outbound-network.api.example.com",
      "permissions.filesystem./tmp/imports",
      "permissions.envVars.EXAMPLE_API_KEY",
      "capabilities.provides.example.capability",
      "artifact.untrusted",
    ]);
    expect(official?.install).toEqual({ confirmationRequired: false, confirmations: [] });
  });

  it("blocks non-official plugin install until required confirmations are provided", async () => {
    const pluginsDir = await writePluginsDirectory([
      {
        id: "com.example.community",
        permissions: {
          scopes: ["drive.write"],
          "outbound-network": ["api.example.com"],
          filesystem: [],
          envVars: [],
        },
      },
    ]);
    const registry = createToolRegistry();
    registerPluginTools(registry, { pluginsDir });

    const blocked = await registry.invoke(
      "plugin.install",
      { pluginId: "com.example.community", source: "official" },
      { actor },
    );

    expect(blocked.ok).toBe(true);
    const blockedOutput = blocked.ok ? (blocked.output as PluginInstallOutput) : undefined;
    expect(blockedOutput?.status).toBe("blocked_confirmation_required");
    expect(blockedOutput?.source).toBe("sideload");
    expect(blockedOutput?.confirmations?.map((confirmation) => confirmation.id)).toEqual([
      "source.non_official",
      "permissions.scopes.drive.write",
      "permissions.outbound-network.api.example.com",
      "capabilities.provides.example.capability",
      "artifact.untrusted",
    ]);

    const installed = await registry.invoke(
      "plugin.install",
      {
        pluginId: "com.example.community",
        source: "sideload",
        confirmations: [
          "source.non_official",
          "permissions.scopes.drive.write",
          "permissions.outbound-network.api.example.com",
          "capabilities.provides.example.capability",
          "artifact.untrusted",
        ],
      },
      { actor },
    );

    expect(installed.ok).toBe(true);
    expect(installed.ok ? installed.output : undefined).toMatchObject({
      status: "installed",
      source: "sideload",
      plugin: { id: "com.example.community", version: "1.0.0" },
      lifecycle: { state: "installed", installed: true, source: "sideload" },
    });
  });

  it("installs official plugins without non-official confirmation prompts", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.official" }]);
    const registry = createToolRegistry();
    registerPluginTools(registry, {
      pluginsDir,
      discovery: { pluginTrust: await createPluginTrust(pluginsDir, ["com.example.official"]) },
    });

    const result = await registry.invoke(
      "plugin.install",
      { pluginId: "com.example.official", version: "1.0.0" },
      { actor },
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.output : undefined).toMatchObject({
      status: "installed",
      source: "official",
      confirmations: [],
      plugin: { id: "com.example.official", version: "1.0.0" },
      lifecycle: { state: "installed", installed: true, source: "official" },
    });
  });

  it("enables and disables an installed plugin while preserving lifecycle state in the list", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.lifecycle" }]);
    const registry = createToolRegistry();
    registerPluginTools(registry, {
      pluginsDir,
      discovery: { pluginTrust: await createPluginTrust(pluginsDir, ["com.example.lifecycle"]) },
    });

    const missing = await registry.invoke(
      "plugin.disable",
      { pluginId: "com.example.lifecycle" },
      { actor },
    );
    expect(missing.ok ? missing.output : undefined).toMatchObject({ status: "not_installed" });

    await registry.invoke(
      "plugin.install",
      { pluginId: "com.example.lifecycle", version: "1.0.0" },
      { actor },
    );

    const enabled = await registry.invoke(
      "plugin.enable",
      { pluginId: "com.example.lifecycle" },
      { actor },
    );
    expect(enabled.ok ? enabled.output : undefined).toMatchObject({
      status: "enabled",
      lifecycle: { state: "enabled", installed: true },
    });

    const disabled = await registry.invoke(
      "plugin.disable",
      { pluginId: "com.example.lifecycle" },
      { actor },
    );
    expect(disabled.ok ? disabled.output : undefined).toMatchObject({
      status: "disabled",
      lifecycle: { state: "disabled", installed: true },
    });

    const listed = await registry.invoke("plugin.list", {}, { actor });
    const output = listed.ok ? (listed.output as PluginListOutput) : undefined;
    expect(output?.plugins[0]?.lifecycle).toMatchObject({
      state: "disabled",
      installed: true,
    });
  });

  it("requires explicit confirmation before uninstalling an installed plugin", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.uninstallable" }]);
    const registry = createToolRegistry();
    registerPluginTools(registry, {
      pluginsDir,
      discovery: {
        pluginTrust: await createPluginTrust(pluginsDir, ["com.example.uninstallable"]),
      },
    });

    await registry.invoke(
      "plugin.install",
      { pluginId: "com.example.uninstallable", version: "1.0.0" },
      { actor },
    );

    const blocked = await registry.invoke(
      "plugin.uninstall",
      { pluginId: "com.example.uninstallable" },
      { actor },
    );
    expect(blocked.ok ? blocked.output : undefined).toMatchObject({
      status: "blocked_confirmation_required",
      confirmations: [{ id: "plugin.uninstall" }],
    });

    const uninstalled = await registry.invoke(
      "plugin.uninstall",
      { pluginId: "com.example.uninstallable", confirmations: ["plugin.uninstall"] },
      { actor },
    );
    expect(uninstalled.ok ? uninstalled.output : undefined).toMatchObject({
      status: "uninstalled",
      lifecycle: { state: "uninstalled", installed: false },
    });
  });

  it("rejects traversal ids and detects cataloged artifacts changed after signing", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.tampered" }]);
    const pluginTrust = await createPluginTrust(pluginsDir, ["com.example.tampered"]);
    await writeFile(join(pluginsDir, "com.example.tampered", "extra.js"), "tampered\n", "utf8");
    const registry = createToolRegistry();
    registerPluginTools(registry, { pluginsDir, discovery: { pluginTrust } });

    const traversal = await registry.invoke(
      "plugin.install",
      { pluginId: "../com.example.tampered", source: "official" },
      { actor },
    );
    expect(traversal.ok).toBe(false);

    const tampered = await registry.invoke(
      "plugin.install",
      { pluginId: "com.example.tampered", source: "official" },
      { actor },
    );
    expect(tampered.ok).toBe(false);
    expect(tampered.ok ? undefined : tampered.error).toContain("bundle digest mismatch");
  });

  it("starts and removes hooks on every replica and rolls back a failed state commit", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.lifecycle" }]);
    const plugin = await discoverPlugin(join(pluginsDir, "com.example.lifecycle"));
    const store = new InMemoryPluginLifecycleStore();
    const events = new InMemoryEventBus();
    const firstRuntime = recordingRuntime();
    const secondRuntime = recordingRuntime();
    const first = new PluginLifecycle({ store, pluginsDir, events, runtime: firstRuntime.runtime });
    const second = new PluginLifecycle({
      store,
      pluginsDir,
      events,
      runtime: secondRuntime.runtime,
    });
    await first.start();
    await second.start();

    await first.transition(plugin, "enabled", "official");
    expect(firstRuntime.enabled).toEqual(["com.example.lifecycle"]);
    expect(secondRuntime.enabled).toEqual(["com.example.lifecycle"]);

    await first.transition(plugin, "disabled", "official");
    expect(firstRuntime.enabled).toEqual([]);
    expect(secondRuntime.enabled).toEqual([]);

    let rolledBack = false;
    const failing = new PluginLifecycle({
      pluginsDir,
      store: {
        get: async () => undefined,
        list: async () => [],
        set: async () => Promise.reject(new Error("db")),
      },
      runtime: {
        disable: () => {},
        prepare: async () => ({
          commit: () => {},
          rollback: () => {
            rolledBack = true;
          },
        }),
      },
    });
    await expect(failing.transition(plugin, "enabled", "official")).rejects.toThrow("db");
    expect(rolledBack).toBe(true);
    await first.close();
    await second.close();
    await events.close();
  });
});

function recordingRuntime(): {
  readonly runtime: PluginRuntimeLifecycle;
  readonly enabled: string[];
} {
  const enabled: string[] = [];
  return {
    enabled,
    runtime: {
      prepare: async (plugin) => ({
        commit: () => enabled.push(plugin.manifest.id),
        rollback: () => {},
      }),
      disable: (pluginId) => {
        const index = enabled.indexOf(pluginId);
        if (index >= 0) enabled.splice(index, 1);
      },
    },
  };
}

async function writePluginsDirectory(manifests: readonly PluginManifestPatch[]): Promise<string> {
  const pluginsDir = await mkdtemp(join(tmpdir(), "helix-plugin-tools-"));
  tempDirs.push(pluginsDir);
  for (const manifest of manifests) {
    const pluginId = manifest.id;
    const rootDir = join(pluginsDir, pluginId);
    await mkdir(rootDir);
    await writeFile(
      join(rootDir, "plugin.json"),
      `${JSON.stringify({ ...baseManifest(), ...manifest }, null, 2)}\n`,
      "utf8",
    );
  }
  return pluginsDir;
}

async function createPluginTrust(
  pluginsDir: string,
  pluginIds: readonly string[],
): Promise<PluginTrustOptions> {
  const plugins = await Promise.all(
    pluginIds.map((pluginId) => discoverPlugin(join(pluginsDir, pluginId))),
  );
  const payload: PluginCatalogPayload = {
    version: 1,
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-03T00:00:00.000Z",
    plugins: await Promise.all(
      plugins.map(async (plugin) => ({
        id: plugin.manifest.id,
        version: plugin.manifest.version,
        ...testArtifactProof(await calculatePluginBundleDigest(plugin)),
      })),
    ),
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "test-catalog";
  return {
    catalog: {
      keyId,
      payload,
      signature: sign(null, pluginCatalogPayloadBytes(payload), privateKey).toString("base64"),
    },
    trustedCatalogKeys: {
      [keyId]: publicKey.export({ format: "pem", type: "spki" }).toString(),
    },
    ...testPublisherTrust(),
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  };
}

function testArtifactProof(
  bundleDigest: string,
): Pick<PluginCatalogEntry, "bundleDigest" | "publisher" | "sigstoreBundle"> {
  return {
    bundleDigest,
    publisher: "helix-release",
    sigstoreBundle: { testDigest: bundleDigest } as unknown as PluginCatalogEntry["sigstoreBundle"],
  };
}

function testPublisherTrust(): Pick<
  PluginTrustOptions,
  "trustedPublishers" | "createBundleVerifier"
> {
  return {
    trustedPublishers: {
      "helix-release": {
        issuer: "https://token.actions.githubusercontent.com",
        uri: "https://github.com/helix/workspace/.github/workflows/release.yml@refs/heads/main",
      },
    },
    createBundleVerifier: async () => ({
      verify(bundle, data) {
        const marker = (bundle as unknown as { readonly testDigest?: string }).testDigest;
        if (marker !== data?.toString("utf8")) throw new Error("invalid test proof");
        return {} as never;
      },
    }),
  };
}

interface PluginManifestPatch extends Partial<PluginManifest> {
  readonly id: string;
}

function baseManifest(): PluginManifest {
  return {
    id: "com.example.plugin",
    name: "Example Plugin",
    version: "1.0.0",
    sdkVersion: "^1.0.0",
    kind: "sandboxed",
    main: "index.js",
    capabilities: {
      provides: ["example.capability"],
      consumes: [],
    },
    permissions: {
      scopes: [],
      "outbound-network": [],
      filesystem: [],
      envVars: [],
    },
  };
}

interface PluginListOutput {
  readonly plugins: readonly {
    readonly id: string;
    readonly lifecycle?: {
      readonly state?: string;
      readonly installed?: boolean;
    };
    readonly install: {
      readonly confirmationRequired: boolean;
      readonly confirmations: readonly { readonly id: string }[];
    };
  }[];
}

interface PluginInstallOutput {
  readonly status: string;
  readonly source?: string;
  readonly confirmations?: readonly { readonly id: string }[];
}
