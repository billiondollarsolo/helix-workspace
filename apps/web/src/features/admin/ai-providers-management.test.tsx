// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMultiProviderAiPatch,
  editorStateFromAiConfig,
  emptyProviderRow,
  type AiProvidersEditorState,
} from "./ai-providers-config";
import { AIProvidersManagement } from "./ai-providers-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const baselineEmpty: AiProvidersEditorState = {
  providers: [],
  routes: [
    { feature: "assistant.chat", providerId: "", model: "" },
    { feature: "mail.spam-ai", providerId: "", model: "" },
    { feature: "mail.compose-help", providerId: "", model: "" },
  ],
  spamBetaMode: "env",
  maxToolRounds: "16",
};

describe("buildMultiProviderAiPatch", () => {
  it("preserves a provider's processing region when saving its other settings", () => {
    const baseline = editorStateFromAiConfig({
      providers: [
        {
          id: "regional",
          plugin: "openai-compat",
          config: {
            region: "eu-central",
            baseUrl: "https://regional.example/v1",
            models: ["model"],
            defaultModel: "model",
            apiKeyConfigured: true,
          },
        },
      ],
    });
    const patch = buildMultiProviderAiPatch(baseline, baseline);
    if (typeof patch === "string") throw new Error(patch);
    expect(patch.providers?.[0]?.config).toMatchObject({ region: "eu-central" });
    expect(patch.providers?.[0]?.config?.apiKey).toBeUndefined();
  });
  it("loads, validates and updates the Assistant step limit without changing secrets", () => {
    const baseline = editorStateFromAiConfig({
      assistant: { maxToolRounds: 32 },
      providers: [{ id: "chat", plugin: "openai-compat", config: { apiKeyConfigured: true } }],
    });
    expect(baseline.maxToolRounds).toBe("32");
    for (const maxToolRounds of ["", "0", "-1", "257", "1.5", "invalid"])
      expect(buildMultiProviderAiPatch({ ...baseline, maxToolRounds }, baseline)).toMatch(
        /whole number from 1 to 256/u,
      );
    expect(editorStateFromAiConfig(undefined).maxToolRounds).toBe("128");
    const patch = buildMultiProviderAiPatch({ ...baseline, maxToolRounds: "16" }, baseline);
    expect(patch).toMatchObject({ assistant: { maxToolRounds: 16 } });
    expect(typeof patch !== "string" && patch.providers?.[0]?.config?.apiKey).toBeUndefined();
  });

  it("builds providers and per-feature routing", () => {
    const state: AiProvidersEditorState = {
      providers: [
        {
          ...emptyProviderRow(0),
          id: "chat",
          defaultModel: "gpt-4o",
          modelsCsv: "gpt-4o, gpt-4o-mini",
          apiKey: "sk-chat",
          offerInChat: true,
        },
        {
          ...emptyProviderRow(1),
          id: "spam",
          defaultModel: "gpt-4o-mini",
          modelsCsv: "gpt-4o-mini",
          apiKey: "sk-spam",
          offerInChat: false,
        },
      ],
      routes: [
        { feature: "assistant.chat", providerId: "chat", model: "gpt-4o" },
        { feature: "mail.spam-ai", providerId: "spam", model: "gpt-4o-mini" },
        { feature: "mail.compose-help", providerId: "chat", model: "gpt-4o-mini" },
      ],
      spamBetaMode: "on",
      maxToolRounds: "16",
    };
    const patch = buildMultiProviderAiPatch(state, baselineEmpty);
    expect(typeof patch).not.toBe("string");
    if (typeof patch === "string") {
      return;
    }
    expect(patch.providers).toHaveLength(2);
    expect(patch.routing?.rules).toEqual([
      { feature: "assistant.chat", primary: { providerId: "chat", model: "gpt-4o" } },
      { feature: "mail.spam-ai", primary: { providerId: "spam", model: "gpt-4o-mini" } },
      {
        feature: "mail.compose-help",
        primary: { providerId: "chat", model: "gpt-4o-mini" },
      },
    ]);
    expect(patch.mailSpamAi).toEqual({ betaEnabled: true });
    expect(patch.providers?.[1]?.tags).toEqual(["backend"]);
    expect(patch.providers?.[0]?.config?.apiKey).toBe("sk-chat");
  });

  it("omits apiKey when blank so stored secrets are preserved", () => {
    const state: AiProvidersEditorState = {
      providers: [
        {
          ...emptyProviderRow(0),
          id: "chat",
          apiKey: "",
          apiKeyConfigured: true,
        },
      ],
      routes: [
        { feature: "assistant.chat", providerId: "chat", model: "gpt-4o-mini" },
        { feature: "mail.spam-ai", providerId: "", model: "" },
        { feature: "mail.compose-help", providerId: "", model: "" },
      ],
      spamBetaMode: "env",
      maxToolRounds: "16",
    };
    const patch = buildMultiProviderAiPatch(state, state);
    expect(typeof patch).not.toBe("string");
    if (typeof patch === "string") {
      return;
    }
    expect(patch.providers?.[0]?.config?.apiKey).toBeUndefined();
    expect(patch.mailSpamAi).toBeUndefined();
  });

  it("rejects duplicate provider ids", () => {
    const state: AiProvidersEditorState = {
      providers: [
        { ...emptyProviderRow(0), id: "same" },
        { ...emptyProviderRow(1), id: "same" },
      ],
      routes: baselineEmpty.routes,
      spamBetaMode: "env",
      maxToolRounds: "16",
    };
    expect(buildMultiProviderAiPatch(state, baselineEmpty)).toMatch(/Duplicate provider id/u);
  });
});

describe("editorStateFromAiConfig", () => {
  it("maps stored providers and routing into form rows without secrets", () => {
    const state = editorStateFromAiConfig({
      providers: [
        {
          id: "p1",
          plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
          tags: ["assistant"],
          config: {
            baseUrl: "https://llm.example/v1",
            defaultModel: "gpt-4o",
            models: ["gpt-4o", "gpt-4o-mini"],
            apiKeyConfigured: true,
          },
        },
      ],
      routing: {
        rules: [{ feature: "assistant.chat", primary: { providerId: "p1", model: "gpt-4o" } }],
      },
      mailSpamAi: { betaEnabled: true },
    });
    expect(state.providers[0]).toMatchObject({
      id: "p1",
      apiKey: "",
      apiKeyConfigured: true,
      offerInChat: true,
      defaultModel: "gpt-4o",
    });
    expect(state.routes.find((route) => route.feature === "assistant.chat")).toEqual({
      feature: "assistant.chat",
      providerId: "p1",
      model: "gpt-4o",
    });
    expect(state.spamBetaMode).toBe("on");
  });
});

describe("AIProvidersManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input instanceof Request ? input.url : "";
  }

  async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
    const start = Date.now();
    let lastError: unknown;
    while (Date.now() - start <= timeout) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function buildRouter() {
    const rootRoute = createRootRoute();
    const sectionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/$section",
      component: AIProvidersManagement,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([sectionRoute]),
      history: createMemoryHistory({ initialEntries: ["/admin/ai-providers"] }),
    });
  }

  async function renderPage(): Promise<void> {
    const router = buildRouter();
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          createElement(RouterProvider as any, { router }) as ReactNode,
        ),
      );
      return Promise.resolve();
    });
  }

  it("loads the catalog and saves routing and tool limits without echoing secrets", async () => {
    queryClient.setQueryData(["assistant", "status"], { available: false });
    let stored = {
      security: { tier: "business" as const },
      ai: {
        providers: [
          {
            id: "chat",
            plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
            tags: ["assistant"],
            enabled: true,
            config: {
              baseUrl: "https://api.openai.com/v1",
              defaultModel: "gpt-4o-mini",
              models: ["gpt-4o-mini"],
              apiKeyConfigured: true,
            },
          },
        ],
        routing: {
          rules: [
            {
              feature: "assistant.chat",
              primary: { providerId: "chat", model: "gpt-4o-mini" },
            },
          ],
        },
        mailSpamAi: { betaEnabled: false },
        assistant: { maxToolRounds: 16 },
      },
    };

    fetchMock.mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (
        url.includes("/api/admin/platform-config") &&
        (init?.method === undefined || init.method === "GET")
      ) {
        return Promise.resolve(
          Response.json({
            config: stored,
            readiness: { ready: true, requirements: [] },
          }),
        );
      }
      if (url.includes("/api/admin/platform-config") && init?.method === "PATCH") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
          ai?: {
            providers?: readonly { config?: { apiKey?: string } }[];
            /* The full rule shape, not just `feature`. The narrow version made
               `body.ai.routing` unassignable to `stored.ai.routing`, so this
               fixture never typechecked — and a test fixture that does not
               match the payload it stands in for is describing a response the
               product does not send. */
            routing?: {
              rules?: readonly {
                feature: string;
                primary: { providerId: string; model: string };
              }[];
            };
            mailSpamAi?: { betaEnabled?: boolean };
            assistant?: { maxToolRounds: number };
          };
        };
        expect(body.ai?.providers?.[0]?.config?.apiKey).toBeUndefined();
        expect(JSON.stringify(body)).not.toMatch(/sk-/u);
        stored = {
          security: { tier: "business" },
          ai: {
            ...stored.ai,
            ...(body.ai?.assistant ? { assistant: body.ai.assistant } : {}),
            ...(body.ai?.mailSpamAi === undefined
              ? {}
              : {
                  mailSpamAi: {
                    betaEnabled: body.ai.mailSpamAi.betaEnabled ?? stored.ai.mailSpamAi.betaEnabled,
                  },
                }),
            /* Normalised rather than spread straight through: the parsed body
               types `rules` as optional and readonly, while the stored config
               requires a mutable list. Falling back to what is already stored
               when the PATCH omits rules is also what the server does. */
            ...(body.ai?.routing === undefined
              ? {}
              : { routing: { rules: [...(body.ai.routing.rules ?? stored.ai.routing.rules)] } }),
            providers: stored.ai.providers,
          },
        };
        return Promise.resolve(
          Response.json({
            config: stored,
            readiness: { ready: true, requirements: [] },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    await renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("Models");
      expect(container.textContent).toContain("chat");
      expect(container.textContent).toContain("Feature routing");
      expect(container.textContent).not.toContain("sk-");
    });

    const spamSelect = container.querySelector('select[aria-label="Mail spam AI beta mode"]');
    expect(spamSelect).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(spamSelect, "on");
      spamSelect?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    const steps = container.querySelector<HTMLInputElement>(
      'input[type="number"][aria-describedby="assistant-tool-steps-help"]',
    );
    expect(steps?.value).toBe("16");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(steps, "32");
      steps?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save AI settings"),
    );
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Saved.");
      expect(stored.ai.assistant.maxToolRounds).toBe(32);
      expect(steps?.value).toBe("32");
      expect(queryClient.getQueryState(["assistant", "status"])?.isInvalidated).toBe(true);
    });
  });

  it("edits in a panel, preserves its draft on refetch and cancels without saving", async () => {
    const config = {
      security: { tier: "business" },
      ai: {
        providers: [
          {
            id: "chat",
            plugin: "openai-compat",
            config: {
              displayName: "Chat",
              models: ["model-a", "model-b"],
              defaultModel: "model-a",
              apiKeyConfigured: true,
            },
          },
        ],
      },
    };
    fetchMock.mockResolvedValue(
      Response.json({ config, readiness: { ready: true, requirements: [] } }),
    );
    await renderPage();
    await waitFor(() =>
      expect(container.querySelector('table[aria-label="AI providers"]')?.textContent).toContain(
        "Chat",
      ),
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Edit provider chat"]')
        ?.click();
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).not.toBe("true");
    const name = [...document.body.querySelectorAll("label")]
      .find((label) => label.textContent === "Display name")
      ?.querySelector("input");
    if (!name) throw new Error("Provider name missing");
    act(() => {
      name.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "My draft",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      queryClient.setQueryData(["admin", "platform-config"], {
        config: { ...config, ai: { ...config.ai, assistant: { maxToolRounds: 64 } } },
        readiness: { ready: true, requirements: [] },
      });
    });
    expect(name.value).toBe("My draft");
    expect(document.activeElement).toBe(name);
    expect(dialog?.querySelector('table[aria-label="Provider models"]')?.textContent).toContain(
      "model-b",
    );
    act(() => {
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "Cancel")
        ?.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
});

it("preserves native and deployment-managed provider protocols when saving", () => {
  const baseline = editorStateFromAiConfig({
    providers: [
      {
        id: "claude",
        plugin: "anthropic-compatible",
        config: {
          baseUrl: "https://api.anthropic.com/v1",
          defaultModel: "claude",
          models: ["claude"],
          apiKeyConfigured: true,
        },
      },
      {
        id: "bedrock",
        plugin: "bedrock",
        config: { region: "us-east-2", defaultModel: "cloud-model", models: ["cloud-model"] },
      },
    ],
  });
  const patch = buildMultiProviderAiPatch(baseline, baseline);
  if (typeof patch === "string") throw new Error(patch);
  expect(patch.providers?.map((row) => row.plugin)).toEqual(["anthropic-compatible", "bedrock"]);
  expect(patch.providers?.[1]?.config?.region).toBe("us-east-2");
  expect(patch.operatorLlm).toBeUndefined();
});

it("keeps meeting speech and summary routes independent across all text-provider protocols", () => {
  const baseline = editorStateFromAiConfig({
    providers: [
      {
        id: "speech",
        plugin: "openai-compat",
        config: { realtimeTranscription: true, models: ["speech-a"], defaultModel: "speech-a" },
      },
      {
        id: "recap",
        plugin: "anthropic-compatible",
        config: { models: ["text-a"], defaultModel: "text-a" },
      },
    ],
  });
  expect(baseline.routes.filter((route) => route.feature.startsWith("meet."))).toEqual([
    { feature: "meet.transcribe", providerId: "", model: "" },
    { feature: "meet.summarize", providerId: "", model: "" },
  ]);
  const configured = {
    ...baseline,
    routes: baseline.routes.map((route) =>
      route.feature === "meet.transcribe"
        ? { ...route, providerId: "speech", model: "speech-a" }
        : route.feature === "meet.summarize"
          ? { ...route, providerId: "recap", model: "text-a" }
          : route,
    ),
  };
  const patch = buildMultiProviderAiPatch(configured, baseline);
  if (typeof patch === "string") throw new Error(patch);
  expect(patch.routing?.rules?.filter((route) => route.feature.startsWith("meet."))).toEqual([
    { feature: "meet.transcribe", primary: { providerId: "speech", model: "speech-a" } },
    { feature: "meet.summarize", primary: { providerId: "recap", model: "text-a" } },
  ]);
  expect(patch.providers?.[0]?.config?.realtimeTranscription).toBe(true);
  const incompatible = {
    ...configured,
    providers: configured.providers.map((provider) => ({
      ...provider,
      realtimeTranscription: false,
    })),
  };
  expect(buildMultiProviderAiPatch(incompatible, baseline)).toContain(
    "realtime speech transcription",
  );
});
