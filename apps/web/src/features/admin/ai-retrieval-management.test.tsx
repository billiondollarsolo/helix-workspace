// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AIRetrievalManagement } from "./ai-retrieval-management";
import { adminPlatformConfigQueryKey } from "./tier-readiness/api";

vi.mock("./admin-related-nav", () => ({ AdminAiRelatedNav: () => null }));
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock("@/lib/auth", () => ({ authenticatedFetch: fetchMock }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const baseline = {
  config: {
    security: { tier: "business" },
    ai: {
      embeddingProvider: {
        plugin: "openai-compat",
        config: {
          baseUrl: "https://embedding.example/v1",
          defaultModel: "original-model",
          dimensions: 1024,
          apiKeyConfigured: true,
        },
      },
    },
  },
  readiness: { ready: true, requirements: [] },
};
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(adminPlatformConfigQueryKey, baseline);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({
      vector: {
        enabled: false,
        backend: null,
        embeddingModel: null,
        dimensions: null,
        collection: null,
      },
      web: { enabled: false },
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
it("keeps the operator's draft when shared settings refresh, and discard adopts the latest saved values", async () => {
  await act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(AIRetrievalManagement)),
    );
    return Promise.resolve();
  });
  const model = Array.from(container.querySelectorAll("input")).find(
    (input) => input.value === "original-model",
  );
  expect(model).toBeDefined();
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(model, "operator-draft");
    model?.dispatchEvent(new Event("input", { bubbles: true }));
    return Promise.resolve();
  });
  expect(model?.value).toBe("operator-draft");
  const chunkField = (label: string) =>
    [...container.querySelectorAll("label")]
      .find((item) => item.textContent?.trim() === label)
      ?.querySelector("input");
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (const [label, value] of [
      ["Chunk size (characters)", "2048"],
      ["Chunk overlap (characters)", "256"],
    ]) {
      const input = chunkField(label!);
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return Promise.resolve();
  });
  await act(() => {
    client.setQueryData(adminPlatformConfigQueryKey, {
      ...baseline,
      config: {
        ...baseline.config,
        ai: {
          embeddingProvider: {
            ...baseline.config.ai.embeddingProvider,
            config: {
              ...baseline.config.ai.embeddingProvider.config,
              defaultModel: "updated-on-server",
              maxInputChars: 4096,
              chunkOverlapChars: 512,
            },
          },
        },
      },
    });
    return Promise.resolve();
  });
  expect(model?.value).toBe("operator-draft");
  expect(chunkField("Chunk size (characters)")?.value).toBe("2048");
  expect(chunkField("Chunk overlap (characters)")?.value).toBe("256");
  const discard = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Discard changes",
  );
  await act(() => {
    discard?.click();
    return Promise.resolve();
  });
  expect(model?.value).toBe("updated-on-server");
  expect(chunkField("Chunk size (characters)")?.value).toBe("4096");
  expect(chunkField("Chunk overlap (characters)")?.value).toBe("512");
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
});

it("preserves a failed settings draft, clears keys explicitly, and tests or indexes only saved settings", async () => {
  const patches: unknown[] = [];
  const tests: unknown[] = [];
  let cancelled = false;
  const saved = {
    ...baseline,
    config: {
      ...baseline.config,
      ai: {
        ...baseline.config.ai,
        embeddingProvider: {
          ...baseline.config.ai.embeddingProvider,
          config: { ...baseline.config.ai.embeddingProvider.config, apiKeyConfigured: false },
        },
        vectorStore: {
          plugin: "qdrant",
          config: { enabled: true, baseUrl: "https://qdrant.example", apiKeyConfigured: true },
        },
        webSearch: {
          enabled: true,
          provider: "searxng",
          baseUrl: "https://search.example",
          maxResults: 7,
          apiKeyConfigured: false,
        },
      },
    },
  };
  fetchMock.mockImplementation((input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (path.endsWith("/platform-config") && init?.method === "PATCH") {
      patches.push(JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown);
      return Promise.resolve(
        patches.length === 1
          ? Response.json({ error: "Could not save settings. Try again." }, { status: 503 })
          : Response.json(saved),
      );
    }
    if (path.endsWith("/ai-retrieval/test")) {
      tests.push(JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown);
      return Promise.resolve(
        Response.json({
          ok: true,
          message: "Saved connection works.",
          latencyMs: 10,
          checkedAt: "2026-09-10T18:00:00Z",
        }),
      );
    }
    if (path.endsWith("/cancel")) {
      cancelled = true;
      return Promise.resolve(Response.json({ status: "cancelled" }));
    }
    if (path.endsWith("/ai-retrieval/reindex") || path.endsWith("/jobs/job-1")) {
      return Promise.resolve(
        Response.json({
          id: "job-1",
          status: cancelled ? "cancelled" : "processing",
          phase: "backfill",
          totalDocuments: "12",
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        vector: {
          enabled: patches.length > 1,
          backend: "qdrant",
          embeddingModel: "original-model",
          dimensions: 1024,
          collection: "source-index",
        },
        web: { enabled: patches.length > 1 },
      }),
    );
  });
  await act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(AIRetrievalManagement)),
    );
    return Promise.resolve();
  });
  await toggle("Enable semantic search");
  await fill("Vector database", "qdrant");
  await fill("Qdrant endpoint", "https://qdrant.example");
  await fill("Qdrant API key", "qdrant-new-key");
  await toggle("Clear stored embedding api key");
  await toggle("Enable web search");
  await fill("Search provider", "searxng");
  await fill("SearXNG endpoint", "https://search.example");
  await fill("Maximum search results", "7");
  expect(button("Test saved vector connection").disabled).toBe(true);
  expect(button("Index workspace content").disabled).toBe(true);
  await click("Save retrieval settings");
  await expectText("Could not save settings. Try again.");
  expect(control("Qdrant API key").value).toBe("qdrant-new-key");
  expect((control("Clear stored embedding api key") as HTMLInputElement).checked).toBe(true);
  await click("Save retrieval settings");
  await expectText("Retrieval settings saved.");
  expect(patches).toHaveLength(2);
  expect(patches[0]).toEqual(patches[1]);
  expect(patches[1]).toMatchObject({
    ai: {
      vectorStore: {
        plugin: "qdrant",
        config: { enabled: true, baseUrl: "https://qdrant.example", apiKey: "qdrant-new-key" },
      },
      embeddingProvider: { config: { apiKey: null } },
      webSearch: {
        enabled: true,
        provider: "searxng",
        baseUrl: "https://search.example",
        maxResults: 7,
      },
    },
  });
  expect(control("Qdrant API key").value).toBe("");
  expect(button("Save retrieval settings").disabled).toBe(true);
  await click("Test saved vector connection");
  await expectText("Saved connection works.");
  expect(tests).toEqual([{ target: "vector" }]);
  expect(patches).toHaveLength(2);
  await click("Index workspace content");
  await expectText("Indexing processing");
  expect(button("Index workspace content").disabled).toBe(true);
  await click("Cancel indexing");
  await expectText("Indexing cancelled");
  expect(cancelled).toBe(true);
  expect(button("Index workspace content").disabled).toBe(false);
});

function control(name: string): HTMLInputElement | HTMLSelectElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (element) =>
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("")
        .trim() === name,
  );
  const element = label?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
  if (!element) throw new Error(`Missing control: ${name}`);
  return element;
}
function button(name: string): HTMLButtonElement {
  const element = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === name,
  );
  if (!element) throw new Error(`Missing button: ${name}`);
  return element;
}
async function fill(name: string, value: string) {
  await act(() => {
    const element = control(name);
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
    return Promise.resolve();
  });
}
async function toggle(name: string) {
  await act(() => {
    control(name).click();
    return Promise.resolve();
  });
}
async function click(name: string) {
  await act(() => {
    button(name).click();
    return Promise.resolve();
  });
}
async function expectText(text: string) {
  await vi.waitFor(async () => {
    await act(() => Promise.resolve());
    expect(container.textContent).toContain(text);
  });
}
