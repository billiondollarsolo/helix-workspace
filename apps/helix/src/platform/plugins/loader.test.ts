import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HelixConfig, PlatformHost, PluginManifest } from "@helix/sdk";
import { resolveTierDefaults } from "../config/tier.js";
import {
  calculatePluginBundleDigest,
  discoverPlugin,
  discoverPluginsDirectory,
  InProcessPluginRuntime,
  pluginTierPolicyFromSecurityDefaults,
} from "./loader.js";

const tempDirs: string[] = [];
const bundledPluginsDir = fileURLToPath(new URL("../../../../../plugins", import.meta.url));
const localOnlyAiPolicy = {
  tier: "sovereign",
  pluginSignatureRequired: false,
  localAiOnly: true,
  airgapRequired: false,
} as const;

describe("plugin tier policy enforcement", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("converts Helix config and resolved tier defaults into plugin tier policy", () => {
    const config: HelixConfig = { security: { tier: "sovereign" } };
    const defaults = resolveTierDefaults(config);

    expect(pluginTierPolicyFromSecurityDefaults(config)).toEqual({
      tier: "sovereign",
      pluginSignatureRequired: true,
      localAiOnly: true,
      airgapRequired: true,
    });
    expect(pluginTierPolicyFromSecurityDefaults(defaults)).toEqual({
      tier: "sovereign",
      pluginSignatureRequired: true,
      localAiOnly: true,
      airgapRequired: true,
    });
  });

  it("rejects plugins prohibited for the active tier", async () => {
    const rootDir = await writePlugin({
      id: "com.example.prohibited",
      tierRequirements: {
        tierRestrictions: {
          sovereign: { prohibited: true },
        },
      },
    });

    await expect(discoverPlugin(rootDir, { tierPolicy: { tier: "sovereign" } })).rejects.toThrow(
      "prohibited in sovereign tier",
    );
  });

  it("requires signature evidence when tier defaults require signed plugins", async () => {
    const unsignedRoot = await writePlugin({ id: "com.example.unsigned" });
    const signedRoot = await writeSignedPlugin({
      id: "com.example.signed",
      signature: {
        signerIdentity: "https://issuer.example/helix-builder",
      },
    });

    await expect(
      discoverPlugin(unsignedRoot, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      }),
    ).rejects.toThrow("requires signed artifact evidence");
    await expect(
      discoverPlugin(signedRoot, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      }),
    ).resolves.toMatchObject({ manifest: { id: "com.example.signed" } });
  });

  it("rejects signature evidence when the declared bundle digest does not match plugin bytes", async () => {
    const mismatchedRoot = await writePlugin({
      id: "com.example.mismatched",
      signature: {
        bundleDigest: validDigestWithChar("b"),
        signerIdentity: "https://issuer.example/helix-builder",
      },
    });

    await expect(
      discoverPlugin(mismatchedRoot, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      }),
    ).rejects.toThrow("bundle digest mismatch");
  });

  it("rejects a signed plugin when files are tampered after digest calculation", async () => {
    const rootDir = await writeSignedPlugin({
      id: "com.example.tampered",
      signature: {
        signerIdentity: "https://issuer.example/helix-builder",
      },
    });
    await writeFile(join(rootDir, "index.js"), "export default { tampered: true };\n", "utf8");

    await expect(
      discoverPlugin(rootDir, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      }),
    ).rejects.toThrow("bundle digest mismatch");
  });

  it("rejects cloud AI providers under local-only policy", async () => {
    const rootDir = await writePlugin({
      id: "com.example.cloudai",
      capabilities: {
        provides: ["ai.provider.llm", "ai.provider.anthropic-compatible"],
        consumes: ["platform.config"],
      },
      permissions: {
        scopes: ["ai:invoke"],
        "outbound-network": ["api.anthropic.com"],
        filesystem: [],
        envVars: ["ANTHROPIC_API_KEY"],
      },
      ai: { protocol: "anthropic-compatible" },
    });

    await expect(
      discoverPlugin(rootDir, {
        tierPolicy: {
          tier: "sovereign",
          pluginSignatureRequired: false,
          localAiOnly: true,
          airgapRequired: false,
        },
      }),
    ).rejects.toThrow("not permitted by local-only AI policy");
  });

  it("allows local AI providers under local-only policy", async () => {
    const rootDir = await writePlugin({
      id: "com.example.localai",
      capabilities: {
        provides: ["ai.provider.llm", "ai.provider.openai-compatible"],
        consumes: ["platform.config"],
      },
      permissions: {
        scopes: ["ai:invoke"],
        "outbound-network": ["config.baseUrl"],
        filesystem: [],
        envVars: ["OLLAMA_BASE_URL"],
      },
      ai: {
        protocol: "openai-compatible",
        localBaseUrls: ["http://localhost:11434/v1"],
      },
    });

    await expect(
      discoverPlugin(rootDir, {
        tierPolicy: {
          tier: "sovereign",
          pluginSignatureRequired: false,
          localAiOnly: true,
          airgapRequired: false,
        },
      }),
    ).resolves.toMatchObject({ manifest: { id: "com.example.localai" } });
  });

  it("derives sovereign signature defaults when runtime loading from a directory", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.unsigned" }]);
    const runtime = new InProcessPluginRuntime({
      async createHost() {
        throw new Error("host should not be created for rejected plugins");
      },
    });

    await expect(
      runtime.loadFromDirectory(pluginsDir, { tierPolicy: { tier: "sovereign" } }),
    ).rejects.toThrow("requires signed artifact evidence");
  });

  it("rejects signed non-local AI providers from resolved sovereign defaults during directory discovery", async () => {
    const pluginsDir = await writeSignedPluginsDirectory([
      {
        id: "com.example.signed-cloudai",
        signature: {
          signerIdentity: "https://issuer.example/helix-builder",
        },
        capabilities: {
          provides: ["ai.provider.llm", "ai.provider.anthropic-compatible"],
          consumes: ["platform.config"],
        },
        permissions: {
          scopes: ["ai:invoke"],
          "outbound-network": ["api.anthropic.com"],
          filesystem: [],
          envVars: ["ANTHROPIC_API_KEY"],
        },
        ai: { protocol: "anthropic-compatible" },
      },
    ]);

    await expect(
      discoverPluginsDirectory(pluginsDir, {
        tierDefaults: resolveTierDefaults({ security: { tier: "sovereign" } }),
      }),
    ).rejects.toThrow("not permitted by local-only AI policy");
  });

  it("rejects bundled cloud-only AI provider manifests under sovereign local-only policy", async () => {
    const cloudOnlyProviderIds = [
      "com.helix.ai-provider-anthropic-compat",
      "com.helix.ai-provider-bedrock",
      "com.helix.ai-provider-vertex",
    ];

    for (const pluginId of cloudOnlyProviderIds) {
      await expect(
        discoverPlugin(bundledPluginDir(pluginId), { tierPolicy: localOnlyAiPolicy }),
        pluginId,
      ).rejects.toThrow(`Plugin ${pluginId} is not permitted by local-only AI policy.`);
    }
  });

  it("allows bundled local-compatible provider manifests under sovereign local-only policy", async () => {
    const localCompatibleProviderIds = [
      "com.helix.ai-provider-openai-compat",
      "com.helix.embedding-openai-compat",
    ];

    for (const pluginId of localCompatibleProviderIds) {
      await expect(
        discoverPlugin(bundledPluginDir(pluginId), { tierPolicy: localOnlyAiPolicy }),
        pluginId,
      ).resolves.toMatchObject({ manifest: { id: pluginId } });
    }
  });

  it("fails closed for bundled unsigned provider manifests under resolved sovereign defaults", async () => {
    await expect(
      discoverPlugin(bundledPluginDir("com.helix.ai-provider-openai-compat"), {
        tierDefaults: resolveTierDefaults({ security: { tier: "sovereign" } }),
      }),
    ).rejects.toThrow("requires signed artifact evidence");
  });

  it("classifies bundled vector manifests by air-gap compatibility", async () => {
    const airgapPolicy = {
      tier: "sovereign",
      pluginSignatureRequired: false,
      localAiOnly: true,
      airgapRequired: true,
    } as const;
    const externalVectorStoreIds = [
      "com.helix.vector-chroma",
      "com.helix.vector-milvus",
      "com.helix.vector-qdrant",
      "com.helix.vector-weaviate",
    ];

    for (const pluginId of externalVectorStoreIds) {
      await expect(
        discoverPlugin(bundledPluginDir(pluginId), { tierPolicy: airgapPolicy }),
        pluginId,
      ).rejects.toThrow("declares outbound network access without air-gap compatibility");
    }

    await expect(
      discoverPlugin(bundledPluginDir("com.helix.vector-pgvector"), { tierPolicy: airgapPolicy }),
    ).resolves.toMatchObject({ manifest: { id: "com.helix.vector-pgvector" } });
  });

  it("rejects malformed signature evidence even when signature metadata is present", async () => {
    const rootDir = await writePlugin({
      id: "com.example.malformed-signature",
      signature: {
        bundleDigest: "sha256:abc",
        signerIdentity: "not a signer identity",
      },
    });

    await expect(
      discoverPlugin(rootDir, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      }),
    ).rejects.toThrow("Invalid plugin manifest");
  });
});

describe("in-process plugin runtime", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("loads real plugin modules from a directory and starts them in dependency order", async () => {
    const pluginsDir = await writePluginsDirectory([
      { id: "com.example.feature", dependencies: ["com.example.foundation"] },
      { id: "com.example.foundation" },
    ]);
    const startedPluginIds: string[] = [];
    const runtime = new InProcessPluginRuntime({
      async createHost(plugin) {
        startedPluginIds.push(plugin.manifest.id);
        return { pluginId: plugin.manifest.id } as PlatformHost;
      },
    });

    await runtime.loadFromDirectory(pluginsDir);
    const started = await runtime.startAll();

    expect(startedPluginIds).toEqual(["com.example.foundation", "com.example.feature"]);
    expect(started.map((plugin) => [plugin.manifest.id, plugin.state])).toEqual([
      ["com.example.foundation", "enabled"],
      ["com.example.feature", "enabled"],
    ]);
    expect(runtime.list().map((plugin) => plugin.manifest.id)).toEqual([
      "com.example.foundation",
      "com.example.feature",
    ]);
  });
});

function bundledPluginDir(pluginId: string): string {
  return join(bundledPluginsDir, pluginId);
}

function validDigestWithChar(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

async function writePlugin(manifest: PluginManifestPatch): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "helix-plugin-policy-"));
  tempDirs.push(rootDir);
  await writePluginManifest(rootDir, manifest);
  return rootDir;
}

async function writeSignedPlugin(manifest: PluginManifestPatch): Promise<string> {
  const { signature: _signature, ...unsignedManifest } = manifest;
  void _signature;
  const rootDir = await writePlugin(unsignedManifest);
  await signPluginManifest(rootDir, manifest);
  return rootDir;
}

async function signPluginManifest(rootDir: string, manifest: PluginManifestPatch): Promise<void> {
  const plugin = await discoverPlugin(rootDir);
  const digest = await calculatePluginBundleDigest(plugin);
  await writePluginManifest(rootDir, {
    ...manifest,
    signature: {
      ...(manifest.signature ?? {}),
      bundleDigest: digest,
    },
  });
}

async function writePluginsDirectory(manifests: readonly PluginManifestPatch[]): Promise<string> {
  const pluginsDir = await mkdtemp(join(tmpdir(), "helix-plugin-directory-policy-"));
  tempDirs.push(pluginsDir);
  for (const manifest of manifests) {
    const rootDir = join(pluginsDir, manifest.id ?? "com.example.plugin");
    await mkdir(rootDir);
    await writePluginManifest(rootDir, manifest);
    await writePluginModule(rootDir);
  }
  return pluginsDir;
}

async function writeSignedPluginsDirectory(
  manifests: readonly PluginManifestPatch[],
): Promise<string> {
  const pluginsDir = await writePluginsDirectory(
    manifests.map((manifest) => {
      const { signature: _signature, ...unsignedManifest } = manifest;
      void _signature;
      return unsignedManifest;
    }),
  );
  for (const manifest of manifests) {
    const rootDir = join(pluginsDir, manifest.id ?? "com.example.plugin");
    await signPluginManifest(rootDir, manifest);
  }
  return pluginsDir;
}

async function writePluginManifest(rootDir: string, manifest: PluginManifestPatch): Promise<void> {
  await writeFile(
    join(rootDir, "plugin.json"),
    `${JSON.stringify({ ...baseManifest(), ...manifest }, null, 2)}\n`,
    "utf8",
  );
}

async function writePluginModule(rootDir: string): Promise<void> {
  await writeFile(join(rootDir, "index.js"), "export default {};\n", "utf8");
}

interface PluginManifestPatch extends Partial<PluginManifest> {
  readonly signature?: {
    readonly bundleDigest?: string;
    readonly sigstoreBundle?: string;
    readonly signerIdentity?: string;
  };
}

function baseManifest(): PluginManifest {
  return {
    id: "com.example.plugin",
    name: "Example Plugin",
    version: "1.0.0",
    sdkVersion: "^1.0.0",
    kind: "in-process",
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
