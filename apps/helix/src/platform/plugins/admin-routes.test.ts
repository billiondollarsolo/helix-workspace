import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, PluginManifest } from "@helix/sdk-types";
import type { FastifyInstance } from "fastify";
import { createToolRegistry } from "../tool-registry.js";
import { registerPluginAdminRoutes } from "./admin-routes.js";
import { registerPluginTools } from "./tools.js";

const tempDirs: string[] = [];
const adminActor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Admin",
  scopes: ["admin.plugins"],
};

describe("plugin admin routes", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("lists and reads installable plugins through stable admin routes", async () => {
    const pluginsDir = await writePluginsDirectory([
      { id: "com.example.official" },
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
    const app = await appWithPlugins(pluginsDir, adminActor, ["com.example.official"]);

    const list = await app.inject({ method: "GET", url: "/api/admin/plugins" });
    expect(list.statusCode).toBe(200);
    const plugins = list.json<PluginListResponse>().plugins;
    expect(plugins.map((plugin) => plugin.id)).toEqual([
      "com.example.community",
      "com.example.official",
    ]);
    expect(plugins.find((plugin) => plugin.id === "com.example.community")?.install).toMatchObject({
      confirmationRequired: true,
    });

    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/plugins/com.example.official",
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<PluginDetailResponse>().plugin).toMatchObject({
      id: "com.example.official",
      lifecycle: { installed: false, state: "validated" },
    });

    await app.close();
  });

  it("wraps plugin lifecycle tools for install, enable, disable, and uninstall", async () => {
    const pluginsDir = await writePluginsDirectory([{ id: "com.example.lifecycle" }]);
    const app = await appWithPlugins(pluginsDir, adminActor);

    const installed = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/com.example.lifecycle/install",
      payload: { version: "1.0.0" },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json<PluginActionResponse>()).toMatchObject({
      status: "installed",
      lifecycle: { state: "installed", installed: true },
    });

    const enabled = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/com.example.lifecycle/enable",
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<PluginActionResponse>()).toMatchObject({
      status: "enabled",
      lifecycle: { state: "enabled", installed: true },
    });

    const disabled = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/com.example.lifecycle/disable",
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<PluginActionResponse>()).toMatchObject({
      status: "disabled",
      lifecycle: { state: "disabled", installed: true },
    });

    const blockedUninstall = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/com.example.lifecycle/uninstall",
    });
    expect(blockedUninstall.statusCode).toBe(200);
    expect(blockedUninstall.json<PluginActionResponse>()).toMatchObject({
      status: "blocked_confirmation_required",
      confirmations: [{ id: "plugin.uninstall" }],
    });

    const uninstalled = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/com.example.lifecycle/uninstall",
      payload: { confirmations: ["plugin.uninstall"] },
    });
    expect(uninstalled.statusCode).toBe(200);
    expect(uninstalled.json<PluginActionResponse>()).toMatchObject({
      status: "uninstalled",
      lifecycle: { state: "uninstalled", installed: false },
    });

    await app.close();
  });

  it("returns confirmation requirements for non-official installs and protects admin scope", async () => {
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
    const app = await appWithPlugins(pluginsDir, { ...adminActor, scopes: ["mail.read"] }, []);

    const forbidden = await app.inject({ method: "GET", url: "/api/admin/plugins" });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      error: "Admin plugin permission denied.",
      requiredScope: "admin.plugins",
    });

    await app.close();

    const adminApp = await appWithPlugins(pluginsDir, adminActor, []);
    const blocked = await adminApp.inject({
      method: "POST",
      url: "/api/admin/plugins/com.example.community/install",
      payload: { source: "sideload" },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json<PluginActionResponse>()).toMatchObject({
      status: "blocked_confirmation_required",
      source: "sideload",
    });
    expect(blocked.json<PluginActionResponse>().confirmations?.map((item) => item.id)).toEqual([
      "source.non_official",
      "permissions.scopes.drive.write",
      "permissions.outbound-network.api.example.com",
      "capabilities.provides.example.capability",
      "signature.missing",
    ]);

    await adminApp.close();
  });
});

async function appWithPlugins(
  pluginsDir: string,
  actor: Actor,
  officialPluginIds?: readonly string[],
): Promise<FastifyInstance> {
  const app = fastify();
  const tools = createToolRegistry();
  registerPluginTools(tools, {
    pluginsDir,
    ...(officialPluginIds === undefined ? {} : { officialPluginIds }),
  });
  await registerPluginAdminRoutes(app, {
    tools,
    actorFromRequest: () => actor,
  });
  return app;
}

async function writePluginsDirectory(manifests: readonly PluginManifestPatch[]): Promise<string> {
  const pluginsDir = await mkdtemp(join(tmpdir(), "helix-plugin-admin-routes-"));
  tempDirs.push(pluginsDir);
  for (const manifest of manifests) {
    const rootDir = join(pluginsDir, manifest.id);
    await mkdir(rootDir);
    await writeFile(
      join(rootDir, "plugin.json"),
      `${JSON.stringify({ ...baseManifest(), ...manifest }, null, 2)}\n`,
      "utf8",
    );
  }
  return pluginsDir;
}

interface PluginManifestPatch extends Partial<PluginManifest> {
  readonly id: string;
}

interface PluginListResponse {
  readonly plugins: readonly PluginCatalogItem[];
}

interface PluginDetailResponse {
  readonly plugin: PluginCatalogItem;
}

interface PluginCatalogItem {
  readonly id: string;
  readonly lifecycle: {
    readonly installed: boolean;
    readonly state: string;
  };
  readonly install: {
    readonly confirmationRequired: boolean;
  };
}

interface PluginActionResponse {
  readonly status: string;
  readonly source?: string | undefined;
  readonly lifecycle?: {
    readonly installed: boolean;
    readonly state: string;
  };
  readonly confirmations?: readonly { readonly id: string }[] | undefined;
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
