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
  AIProvidersManagement,
  buildMultiProviderAiPatch,
  editorStateFromAiConfig,
  emptyProviderRow,
  type AiProvidersEditorState,
} from "./ai-providers-management";

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
};

describe("buildMultiProviderAiPatch", () => {
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

  it("loads multi-provider catalog and saves routing without echoing secrets", async () => {
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
            routing?: { rules?: readonly { feature: string }[] };
            mailSpamAi?: { betaEnabled?: boolean };
          };
        };
        expect(body.ai?.providers?.[0]?.config?.apiKey).toBeUndefined();
        expect(JSON.stringify(body)).not.toMatch(/sk-/u);
        stored = {
          security: { tier: "business" },
          ai: {
            ...stored.ai,
            ...(body.ai?.mailSpamAi === undefined ? {} : { mailSpamAi: body.ai.mailSpamAi }),
            ...(body.ai?.routing === undefined ? {} : { routing: body.ai.routing }),
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
      expect(container.textContent).toContain("AI providers");
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

    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save AI settings"),
    );
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Saved.");
    });
  });
});
