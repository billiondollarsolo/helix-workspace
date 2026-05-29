import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  createEditorsRuntimeHost,
  DEFAULT_EDITORS_CORE_APP_MODULE,
  loadEditorsCoreAppModule,
  registerEditorsCoreApp,
  resolveEditorsEnabledRoles,
  resolveEditorsModuleOptions,
  type EditorsCoreAppLogger,
  type EditorsCoreAppModule,
} from "./core-app.js";

describe("resolveEditorsEnabledRoles", () => {
  it("defaults to the primary editors role", () => {
    expect(resolveEditorsEnabledRoles({})).toEqual(["editors"]);
  });

  it("extracts editor role ids from HELIX_APPS and HELIX_ROLE", () => {
    expect(
      resolveEditorsEnabledRoles({
        HELIX_APPS: "mail,editors-conv-worker,editors-collab-gw",
        HELIX_ROLE: "workers",
      }),
    ).toEqual(["editors-conv-worker", "editors-collab-gw"]);

    expect(resolveEditorsEnabledRoles({ HELIX_ROLE: "editors-ocr-worker" })).toEqual([
      "editors-ocr-worker",
    ]);
  });
});

describe("resolveEditorsModuleOptions", () => {
  it("maps Helix module config into editors package options", () => {
    expect(
      resolveEditorsModuleOptions(
        {
          modules: {
            editors: {
              enabled: true,
              config: { ooxmlFidelityMode: "legacy" },
            },
          },
        },
        { HELIX_APPS: "editors-export-worker", HELIX_EDITORS_REGISTER_PLACEHOLDERS: "true" },
      ),
    ).toEqual({
      enabled: true,
      enabledRoles: ["editors-export-worker"],
      ooxmlFidelityMode: "legacy",
      registerPlaceholders: true,
    });
  });

  it("keeps invalid OOXML values out of the package contract", () => {
    expect(
      resolveEditorsModuleOptions(
        { modules: { editors: { config: { ooxmlFidelityMode: "fast" } } } },
        {},
      ).ooxmlFidelityMode,
    ).toBeUndefined();
  });
});

describe("loadEditorsCoreAppModule", () => {
  it("loads a module exporting registerEditorsModule", async () => {
    const module = await loadEditorsCoreAppModule("fake-editors", async () => fakeModule);
    expect(module).toBe(fakeModule);
  });

  it("returns null when the configured package is not installed", async () => {
    const module = await loadEditorsCoreAppModule("missing-editors", async () => {
      const error = new Error("Cannot find package 'missing-editors'");
      Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
      throw error;
    });
    expect(module).toBeNull();
  });

  it("returns null when default package resolution cannot find the optional package", async () => {
    await expect(loadEditorsCoreAppModule("missing-editors-core-app")).resolves.toBeNull();
  });

  it("rejects modules that do not expose the core-app contract", async () => {
    await expect(loadEditorsCoreAppModule("bad-editors", async () => ({}))).rejects.toThrow(
      "registerEditorsModule",
    );
  });
});

describe("registerEditorsCoreApp", () => {
  it("registers the loaded editors package with resolved role options", async () => {
    const calls: unknown[] = [];
    const logger = recordingLogger();
    const result = await registerEditorsCoreApp({
      config: { modules: { editors: { config: { ooxml: "native" } } } },
      env: { HELIX_APPS: "editors-conv-worker" },
      logger,
      importer: async () =>
        ({
          registerEditorsModule: (host, options) => {
            calls.push({ host, options });
            return {
              routes: [],
              tools: [],
              workers: ["editors-conv-worker"],
              previewRenderers: [],
              aiSlots: [],
              collabGateways: [],
              ooxmlFidelityMode: options?.ooxmlFidelityMode ?? "native",
            };
          },
        }) satisfies EditorsCoreAppModule,
    });

    expect(result.status).toBe("registered");
    expect(calls).toMatchObject([
      {
        options: {
          enabled: true,
          enabledRoles: ["editors-conv-worker"],
          ooxmlFidelityMode: "native",
        },
      },
    ]);
    expect(logger.infos).toContain("Editors core app package registered");
  });

  it("skips cleanly when the package is absent", async () => {
    const result = await registerEditorsCoreApp({
      config: {},
      env: {},
      logger: recordingLogger(),
      importer: async () => {
        const error = new Error(`Cannot find package '${DEFAULT_EDITORS_CORE_APP_MODULE}'`);
        Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
        throw error;
      },
    });

    expect(result).toEqual({
      status: "skipped",
      moduleSpecifier: DEFAULT_EDITORS_CORE_APP_MODULE,
      reason: "module-not-installed",
    });
  });

  it("can require the editors package when deployments opt in", async () => {
    await expect(
      registerEditorsCoreApp({
        config: {},
        env: { HELIX_EDITORS_CORE_APP_REQUIRED: "true" },
        logger: recordingLogger(),
        importer: async () => {
          const error = new Error(`Cannot find package '${DEFAULT_EDITORS_CORE_APP_MODULE}'`);
          Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
          throw error;
        },
      }),
    ).rejects.toThrow("Editors core app package is required but not installed");
  });

  it("passes explicit sibling package entry paths to the importer", async () => {
    const calls: string[] = [];
    await registerEditorsCoreApp({
      config: {},
      env: { HELIX_EDITORS_CORE_APP_ENTRY: "/opt/helix/editors-core-app/dist/index.js" },
      logger: recordingLogger(),
      importer: async (specifier) => {
        calls.push(specifier);
        return fakeModule;
      },
    });

    expect(calls).toEqual(["/opt/helix/editors-core-app/dist/index.js"]);
  });
});

describe("createEditorsRuntimeHost", () => {
  it("records placeholder registrations and exposes role metadata", () => {
    const bundle = createEditorsRuntimeHost({
      logger: recordingLogger(),
      env: { HELIX_APPS: "editors,editors-export-worker", HELIX_ROLE: "editors" },
    });

    bundle.host.registerRoute?.("/docs/:id");
    bundle.host.registerTool?.("editors.open");
    bundle.host.registerWorker?.("editors-export-worker");
    bundle.host.registerPreviewRenderer?.("application/pdf");
    bundle.host.registerAiSlot?.("editors.assist");
    bundle.host.registerCollabGateway?.("docs");

    expect(bundle.host.role).toBe("editors");
    expect(bundle.host.apps).toEqual(["editors", "editors-export-worker"]);
    expect(bundle.registrations).toEqual({
      routes: ["/docs/:id"],
      tools: ["editors.open"],
      workers: ["editors-export-worker"],
      previewRenderers: ["application/pdf"],
      aiSlots: ["editors.assist"],
      collabGateways: ["docs"],
    });
  });

  it("forwards real runtime registrations to Fastify, tools, and worker sinks", () => {
    const routed: unknown[] = [];
    const tools: string[] = [];
    const workers: string[] = [];
    const bundle = createEditorsRuntimeHost({
      logger: recordingLogger(),
      app: {
        route: (route) => {
          routed.push(route);
          return undefined as never;
        },
        get: () => undefined as never,
      },
      tools: {
        register: (tool) => void tools.push(tool.id),
      },
      workers: {
        register: (name) => void workers.push(name),
      },
    });

    bundle.host.http?.route({
      method: "GET",
      path: "/api/editors/health",
      async handler(_request, reply) {
        await reply.send({ ok: true });
      },
    });
    bundle.host.tools?.register(fakeTool("editors.open"));
    bundle.host.workers?.register("editors-export-worker", {
      start() {},
      stop() {},
    });

    expect(routed).toHaveLength(1);
    expect(tools).toEqual(["editors.open"]);
    expect(workers).toEqual(["editors-export-worker"]);
    expect(bundle.registrations.routes).toEqual(["GET /api/editors/health"]);
    expect(bundle.registrations.tools).toEqual(["editors.open"]);
    expect(bundle.registrations.workers).toEqual(["editors-export-worker"]);
  });

  it("adapts structural editor HTTP routes to Fastify", async () => {
    const app = fastify();
    const bundle = createEditorsRuntimeHost({
      logger: recordingLogger(),
      app,
    });

    bundle.host.http?.route({
      method: "GET",
      path: "/api/editors/contract",
      async handler(request, reply) {
        reply.header("x-editors-contract", "runtime-host");
        await reply.send({ ok: true, method: request.method, route: request.url });
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/editors/contract" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-editors-contract"]).toBe("runtime-host");
    expect(response.json()).toEqual({
      ok: true,
      method: "GET",
      route: "/api/editors/contract",
    });
  });

  it("passes authenticated actors and document capabilities to editor routes", async () => {
    const app = fastify();
    const bundle = createEditorsRuntimeHost({
      logger: recordingLogger(),
      app,
      actorFromRequest: () => ({
        id: "actor-1",
        orgId: "org-1",
        type: "user",
        displayName: "Ada",
      }),
      documents: {
        async getSession(input) {
          return {
            id: input.documentId,
            orgId: input.orgId,
            title: `Doc for ${input.actor.id}`,
            ownerActorId: input.actor.id,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            updateSeq: 3,
            stateBase64: null,
            stateVectorBase64: null,
            updatedAt: "2026-05-23T12:00:00.000Z",
          };
        },
      },
    });

    bundle.host.http?.route({
      method: "GET",
      path: "/api/editors/documents/:documentId",
      async handler(request, reply) {
        const session = await bundle.host.documents?.getSession({
          actor: request.actor ?? {
            id: "missing",
            orgId: "missing",
            type: "user",
          },
          orgId: request.orgId ?? request.actor?.orgId ?? "missing",
          documentId: request.params.documentId ?? "missing",
        });
        await reply.send({
          actorId: request.actor?.id ?? null,
          documentId: session?.id ?? null,
          title: session?.title ?? null,
          ownerActorId: session?.ownerActorId ?? null,
        });
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/editors/documents/doc-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      actorId: "actor-1",
      documentId: "doc-1",
      title: "Doc for actor-1",
      ownerActorId: "actor-1",
    });
  });
});

const fakeModule: EditorsCoreAppModule = {
  registerEditorsModule: () => ({
    routes: [],
    tools: [],
    workers: [],
    previewRenderers: [],
    aiSlots: [],
    collabGateways: [],
    ooxmlFidelityMode: "native",
  }),
};

function recordingLogger(): EditorsCoreAppLogger & { readonly infos: readonly string[] } {
  const infos: string[] = [];
  return {
    infos,
    debug() {},
    info(_input, message) {
      infos.push(message);
    },
    warn() {},
    error() {},
  };
}

function fakeTool(id: string) {
  return {
    id,
    description: "Fake editor tool.",
    permission: id,
    sideEffects: "read",
    inputSchema: {
      parse(value: unknown) {
        return value;
      },
      toJsonSchema() {
        return { type: "object" };
      },
    },
    outputSchema: {
      parse(value: unknown) {
        return value;
      },
      toJsonSchema() {
        return { type: "object" };
      },
    },
    async handler() {
      return {};
    },
  } as const;
}
