import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HelixConfig, PluginManifest } from "@helix/sdk";
import { resolveTierDefaults } from "../config/tier.js";
import {
  calculatePluginBundleDigest,
  discoverPlugin,
  discoverPluginsDirectory,
  pluginTierPolicyFromSecurityDefaults,
  resolvePluginArtifactPath,
} from "./loader.js";
import {
  pluginCatalogPayloadBytes,
  type PluginCatalogEntry,
  type PluginCatalogPayload,
  type PluginTrustOptions,
} from "./trust.js";

const tempDirs: string[] = [];
const bundledPluginsDir = fileURLToPath(new URL("../../../../../plugins", import.meta.url));
const removedPlaceholderIds = [
  "com.helix.ai-provider-anthropic-compat",
  "com.helix.ai-provider-bedrock",
  "com.helix.ai-provider-openai-compat",
  "com.helix.ai-provider-vertex",
  "com.helix.audit-immutable-s3",
  "com.helix.core.assistant",
  "com.helix.core-asyncapi",
  "com.helix.core.calendar",
  "com.helix.core.chat",
  "com.helix.core-cli",
  "com.helix.core.docs",
  "com.helix.core.drive",
  "com.helix.core.mail",
  "com.helix.core-mcp-server",
  "com.helix.core.meet-jitsi",
  "com.helix.core-openapi",
  "com.helix.core.search-meilisearch",
  "com.helix.core.storage-rustfs",
  "com.helix.embedding-openai-compat",
  "com.helix.observability-grafana-stack",
  "com.helix.observability-otel",
  "com.helix.secrets-sops",
  "com.helix.webhook-engine",
  "com.helix.webhook-in-generic",
  "com.helix.webhook-in-github",
  "com.helix.webhook-in-linear",
  "com.helix.webhook-in-stripe",
  "com.helix.webhook-out-custom-template",
  "com.helix.webhook-out-discord",
  "com.helix.webhook-out-generic",
  "com.helix.webhook-out-teams",
  "com.helix.vector-chroma",
  "com.helix.vector-milvus",
  "com.helix.vector-pgvector",
  "com.helix.vector-qdrant",
  "com.helix.vector-weaviate",
] as const;
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

  it("requires a cryptographically trusted catalog artifact when the tier requires signatures", async () => {
    const unsignedRoot = await writePlugin({ id: "com.example.unsigned" });
    const signedRoot = await writePlugin({ id: "com.example.signed" });
    const pluginTrust = await createPluginTrust([signedRoot]);

    await expect(
      discoverPlugin(unsignedRoot, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      }),
    ).rejects.toThrow("requires a trusted catalog artifact");
    await expect(
      discoverPlugin(signedRoot, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
        pluginTrust,
      }),
    ).resolves.toMatchObject({ manifest: { id: "com.example.signed" } });
  });

  it("rejects signature evidence when the declared bundle digest does not match plugin bytes", async () => {
    const mismatchedRoot = await writePlugin({ id: "com.example.mismatched" });
    const pluginTrust = await createPluginTrust([mismatchedRoot], {
      "com.example.mismatched": validDigestWithChar("b"),
    });

    await expect(
      discoverPlugin(mismatchedRoot, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
        pluginTrust,
      }),
    ).rejects.toThrow("bundle digest mismatch");
  });

  it("rejects a signed plugin when files are tampered after digest calculation", async () => {
    const rootDir = await writePlugin({ id: "com.example.tampered" });
    const pluginTrust = await createPluginTrust([rootDir]);
    await writeFile(join(rootDir, "index.js"), "export default { tampered: true };\n", "utf8");

    await expect(
      discoverPlugin(rootDir, {
        tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
        pluginTrust,
      }),
    ).rejects.toThrow("bundle digest mismatch");
  });

  it("rechecks a verified bundle immediately before resolving its entry point", async () => {
    const rootDir = await writePlugin({ id: "com.example.load-tampered" });
    await writePluginModule(rootDir);
    const pluginTrust = await createPluginTrust([rootDir]);
    const plugin = await discoverPlugin(rootDir, {
      tierPolicy: { tier: "enterprise", pluginSignatureRequired: true },
      pluginTrust,
    });
    await writeFile(join(rootDir, "extra.js"), "tampered\n", "utf8");

    await expect(resolvePluginArtifactPath(plugin, "index.js")).rejects.toThrow(
      "changed after verification",
    );
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

  it("derives sovereign signature defaults during directory discovery", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.unsigned" }]);
    const errors: unknown[] = [];

    await expect(
      discoverPluginsDirectory(pluginsDir, {
        tierPolicy: { tier: "sovereign" },
        onError: (_artifact, error) => errors.push(error),
      }),
    ).resolves.toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("requires a trusted catalog artifact");
  });

  it("rejects signed non-local AI providers from resolved sovereign defaults during directory discovery", async () => {
    const manifests: readonly PluginManifestPatch[] = [
      {
        id: "com.example.signed-cloudai",
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
    ];
    const pluginsDir = await writePluginsDirectory(manifests);
    const pluginTrust = await createPluginTrust(
      manifests.map((manifest) => join(pluginsDir, manifest.id ?? "com.example.plugin")),
    );

    const errors: unknown[] = [];
    await expect(
      discoverPluginsDirectory(pluginsDir, {
        tierDefaults: resolveTierDefaults({ security: { tier: "sovereign" } }),
        pluginTrust,
        onError: (_artifact, error) => errors.push(error),
      }),
    ).resolves.toEqual([]);
    expect(String(errors[0])).toContain("not permitted by local-only AI policy");
  });

  it("rejects traversal, absolute entry points, and escaping symlinks before import", async () => {
    const traversalRoot = await writePlugin({ id: "../outside", main: "../outside.js" });
    await expect(discoverPlugin(traversalRoot)).rejects.toThrow("canonical dotted plugin id");

    const absoluteRoot = await writePlugin({ id: "com.example.absolute", main: "/tmp/outside.js" });
    await expect(discoverPlugin(absoluteRoot)).rejects.toThrow("normalized relative artifact path");

    const symlinkRoot = await writePlugin({ id: "com.example.symlink", main: "index.js" });
    const outsideDir = await mkdtemp(join(tmpdir(), "helix-plugin-outside-"));
    tempDirs.push(outsideDir);
    const outside = join(outsideDir, "outside.js");
    await writeFile(outside, "export default {};\n", "utf8");
    await symlink(outside, join(symlinkRoot, "index.js"));
    const plugin = await discoverPlugin(symlinkRoot);
    await expect(resolvePluginArtifactPath(plugin, "index.js")).rejects.toThrow("symbolic link");
  });

  it("rejects plugin directory symlinks during catalog discovery", async () => {
    const pluginsDir = await writePluginsDirectory([]);
    const outsideRoot = await writePlugin({ id: "com.example.outside" });
    await symlink(outsideRoot, join(pluginsDir, "com.example.escape"));
    const errors: unknown[] = [];

    await expect(
      discoverPluginsDirectory(pluginsDir, {
        onError: (_artifact, error) => errors.push(error),
      }),
    ).resolves.toEqual([]);
    expect(String(errors[0])).toContain("symbolic link");
  });
});

describe("bundled plugin catalog", () => {
  it("contains only executable connectors or health-checked external services", async () => {
    const plugins = await discoverPluginsDirectory(bundledPluginsDir);
    const ids = plugins.map((plugin) => plugin.manifest.id).sort();

    expect(ids).toEqual(["com.helix.webhook-out-slack"]);
    for (const id of removedPlaceholderIds) {
      expect(ids).not.toContain(id);
    }

    for (const plugin of plugins) {
      if (plugin.manifest.main !== undefined && plugin.manifest.main !== null) {
        const source = await readFile(
          await resolvePluginArtifactPath(plugin, plugin.manifest.main),
          "utf8",
        );
        expect(source).not.toMatch(/^\s*export\s+default\s+\{\s*\};?\s*$/u);
        continue;
      }
      expect(plugin.manifest.kind).toBe("external-service");
      expect(plugin.manifest.endpoint).toMatch(/^https?:\/\//u);
      expect(plugin.manifest.composeRecipe).toBeTypeOf("string");
      const compose = await readFile(
        await resolvePluginArtifactPath(plugin, plugin.manifest.composeRecipe ?? ""),
        "utf8",
      );
      expect(compose).toContain("healthcheck:");
    }
  });
});

function validDigestWithChar(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

async function writePlugin(manifest: PluginManifestPatch): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "helix-plugin-policy-"));
  tempDirs.push(rootDir);
  await writePluginManifest(rootDir, manifest);
  return rootDir;
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

async function createPluginTrust(
  rootDirs: readonly string[],
  digestOverrides: Readonly<Record<string, string>> = {},
): Promise<PluginTrustOptions> {
  const plugins = await Promise.all(rootDirs.map((rootDir) => discoverPlugin(rootDir)));
  const payload: PluginCatalogPayload = {
    version: 1,
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-03T00:00:00.000Z",
    plugins: await Promise.all(
      plugins.map(async (plugin) => ({
        id: plugin.manifest.id,
        version: plugin.manifest.version,
        ...testArtifactProof(
          digestOverrides[plugin.manifest.id] ?? (await calculatePluginBundleDigest(plugin)),
        ),
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

async function writePluginManifest(rootDir: string, manifest: PluginManifestPatch): Promise<void> {
  await writeFile(
    join(rootDir, "plugin.json"),
    `${JSON.stringify({ ...baseManifest(), ...manifest }, null, 2)}\n`,
    "utf8",
  );
}

async function writePluginModule(rootDir: string): Promise<void> {
  await writeFile(join(rootDir, "index.js"), "export default { async onStart() {} };\n", "utf8");
}

type PluginManifestPatch = Partial<PluginManifest>;

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
