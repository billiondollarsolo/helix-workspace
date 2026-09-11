import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import type {
  AIConfigStatus,
  AIVectorStoreConfig,
  AIEmbeddingProviderConfig,
  AIWebSearchConfig,
} from "../../src/features/admin/tier-readiness/types";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Retrieval configuration fault injection uses isolated fixtures."),
);

test("saves retrieval with recoverable errors, tests only saved settings and manages durable indexing", async ({
  page,
}) => {
  const backend = await mockRetrieval(page, false, true);
  await page.goto("/admin/ai-retrieval");
  await expect(page.getByRole("heading", { name: "AI retrieval", exact: true })).toBeVisible();
  await expect(page.getByLabel("Enable semantic search")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Test saved vector connection" })).toBeDisabled();
  await page.getByLabel("Enable semantic search").check();
  await page
    .getByLabel("Embedding endpoint", { exact: true })
    .fill("https://embeddings.example/v1");
  await page.getByLabel("Embedding model", { exact: true }).fill("text-embedding-test");
  await page.getByLabel("Embedding dimensions", { exact: true }).fill("1024");
  await page.getByLabel("Chunk size (characters)", { exact: true }).fill("2048");
  await page.getByLabel("Chunk overlap (characters)", { exact: true }).fill("2048");
  await page.getByLabel("Embedding API key", { exact: true }).fill("embedding-test-secret");
  await page.getByLabel("Enable web search").check();
  await page.getByLabel("Search API key", { exact: true }).fill("search-test-secret");
  await expect(page.getByRole("button", { name: "Test saved web connection" })).toBeDisabled();
  const save = page.getByRole("button", { name: "Save retrieval settings" });
  await save.click();
  expect(backend.patches).toHaveLength(0);
  await expect(page.getByLabel("Chunk overlap (characters)", { exact: true })).toBeFocused();
  await page.getByLabel("Chunk overlap (characters)", { exact: true }).fill("256");
  await save.click();
  await expect(page.getByRole("alert")).toContainText(
    "Configuration storage is temporarily unavailable.",
  );
  await expect(page.getByLabel("Embedding API key", { exact: true })).toHaveValue(
    "embedding-test-secret",
  );
  await save.click();
  await expect(page.getByText("Retrieval settings saved.", { exact: true })).toBeVisible();
  expect(backend.patches).toHaveLength(2);
  expect(backend.patches[0]).toEqual(backend.patches[1]);
  expect(backend.patches[1]).toMatchObject({
    ai: {
      vectorStore: { plugin: "pgvector", config: { enabled: true } },
      embeddingProvider: {
        plugin: "openai-compat",
        config: {
          dimensions: 1024,
          maxInputChars: 2048,
          chunkOverlapChars: 256,
          defaultModel: "text-embedding-test",
          apiKey: "embedding-test-secret",
        },
      },
      webSearch: { enabled: true, provider: "brave", apiKey: "search-test-secret", maxResults: 5 },
    },
  });
  await expect(page.getByLabel("Embedding API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Test saved vector connection" }).click();
  await expect(
    page.getByText("Connection works; index workspace content before using semantic search.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(backend.tests).toEqual([{ target: "vector" }]);
  expect(backend.patches).toHaveLength(2);
  await page.getByRole("button", { name: "Index workspace content" }).click();
  await expect(page.getByText(/Indexing processing/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Index workspace content" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel indexing" }).click();
  await expect(page.getByText(/Indexing cancelled/)).toBeVisible();
  expect(backend.cancelled).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Embedding model", { exact: true })).toHaveValue(
    "text-embedding-test",
  );
  await expect(page.getByLabel("Embedding API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Chunk size (characters)", { exact: true })).toHaveValue("2048");
  await expect(page.getByLabel("Chunk overlap (characters)", { exact: true })).toHaveValue("256");
});

test("preserves blank stored secrets and requires explicit replacement or clearing on provider changes", async ({
  page,
}) => {
  const backend = await mockRetrieval(page, true);
  await page.goto("/admin/ai-retrieval");
  await page.getByLabel("Maximum search results").fill("7");
  await page.getByRole("button", { name: "Save retrieval settings" }).click();
  await expect(page.getByText("Retrieval settings saved.", { exact: true })).toBeVisible();
  const first = backend.patches[0] as {
    ai: {
      vectorStore: { config: object };
      embeddingProvider: { config: object };
      webSearch: object;
    };
  };
  expect(first.ai.vectorStore.config).not.toHaveProperty("apiKey");
  expect(first.ai.embeddingProvider.config).not.toHaveProperty("apiKey");
  expect(first.ai.webSearch).not.toHaveProperty("apiKey");
  await page
    .getByRole("combobox", { name: "Search provider", exact: true })
    .selectOption("searxng");
  await page.getByLabel("SearXNG endpoint", { exact: true }).fill("https://search.example");
  await page.getByRole("button", { name: "Save retrieval settings" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Re-enter or clear the stored search key when changing its provider.",
  );
  await expect(page.getByLabel("SearXNG endpoint", { exact: true })).toHaveValue(
    "https://search.example",
  );
  await page.getByLabel("Clear stored search api key", { exact: true }).check();
  await page.getByRole("button", { name: "Save retrieval settings" }).click();
  await expect(page.getByText("Retrieval settings saved.", { exact: true })).toBeVisible();
  expect(backend.patches.at(-1)).toMatchObject({
    ai: { webSearch: { provider: "searxng", baseUrl: "https://search.example", apiKey: null } },
  });
  await page.getByRole("button", { name: "Test saved web connection" }).click();
  await expect(page.getByText("Search connection works.", { exact: false })).toBeVisible();
});

for (const width of [390, 768, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`retrieval settings are accessible at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(
        (theme) =>
          localStorage.setItem(
            "helix-appearance",
            JSON.stringify({ theme, density: "compact", accent: "#7c3aed", fontScale: "default" }),
          ),
        theme,
      );
      await mockRetrieval(page, true);
      await page.goto("/admin/ai-retrieval");
      await page
        .getByRole("combobox", { name: "Search provider", exact: true })
        .selectOption("searxng");
      await expect(page.getByLabel("SearXNG endpoint", { exact: true })).toBeVisible();
      await page.addScriptTag({ content: axe.source });
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as typeof window & { axe: typeof axe }).axe.run(document, {
                runOnly: {
                  type: "tag",
                  values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
                },
              })
            ).violations,
        ),
      ).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }

async function mockRetrieval(page: Page, configured: boolean, failFirst = false) {
  await seedBrowserSession(page, "retrieval-session");
  let ai: AIConfigStatus = configured
    ? {
        vectorStore: {
          plugin: "qdrant",
          config: { enabled: true, baseUrl: "https://qdrant.example", apiKeyConfigured: true },
        },
        embeddingProvider: {
          plugin: "openai-compat",
          config: {
            baseUrl: "https://embed.example/v1",
            defaultModel: "embed-test",
            dimensions: 1024,
            apiKeyConfigured: true,
          },
        },
        webSearch: { enabled: true, provider: "brave", apiKeyConfigured: true, maxResults: 5 },
      }
    : {};
  const backend = { patches: [] as unknown[], tests: [] as unknown[], cancelled: false };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/platform-config")) {
      if (request.method() === "PATCH") {
        expect(request.headers()["x-helix-csrf-token"]).toBe("e2e-csrf-token");
        const patch = request.postDataJSON() as {
          ai: {
            vectorStore: AIVectorStoreConfig;
            embeddingProvider?: AIEmbeddingProviderConfig;
            webSearch: AIWebSearchConfig;
          };
        };
        backend.patches.push(patch);
        if (failFirst && backend.patches.length === 1)
          return route.fulfill({
            status: 503,
            json: { error: "Configuration storage is temporarily unavailable." },
          });
        if (
          ai.webSearch?.apiKeyConfigured &&
          patch.ai.webSearch.provider !== ai.webSearch.provider &&
          patch.ai.webSearch.apiKey === undefined
        )
          return route.fulfill({
            status: 400,
            json: { error: "Re-enter or clear the stored search key when changing its provider." },
          });
        const { vectorStore, embeddingProvider, webSearch } = patch.ai;
        ai = {
          ...ai,
          vectorStore: {
            plugin: vectorStore.plugin,
            config: sanitizeKey(vectorStore.config, ai.vectorStore?.config),
          },
          ...(embeddingProvider
            ? {
                embeddingProvider: {
                  plugin: embeddingProvider.plugin,
                  config: sanitizeKey(embeddingProvider.config, ai.embeddingProvider?.config),
                },
              }
            : {}),
          webSearch: sanitizeKey(webSearch, ai.webSearch),
        };
      }
      return route.fulfill({
        json: {
          config: { security: { tier: "business" }, ai },
          readiness: { ready: true, requirements: [] },
        },
      });
    }
    if (path.endsWith("/ai-retrieval/status"))
      return route.fulfill({
        json: {
          vector: {
            enabled: ai.vectorStore?.config.enabled === true,
            backend: ai.vectorStore?.plugin ?? null,
            embeddingModel: ai.embeddingProvider?.config.defaultModel ?? null,
            dimensions: ai.embeddingProvider?.config.dimensions ?? null,
            collection: null,
          },
          web: { enabled: ai.webSearch?.enabled === true },
        },
      });
    if (path.endsWith("/ai-retrieval/test")) {
      backend.tests.push(request.postDataJSON());
      return route.fulfill({
        json: {
          ok: true,
          message:
            request.postDataJSON().target === "vector"
              ? "Connection works; index workspace content before using semantic search."
              : "Search connection works.",
          latencyMs: 12,
          checkedAt: "2026-09-10T18:00:00Z",
        },
      });
    }
    const job = {
      id: "reindex-1",
      status: backend.cancelled ? "cancelled" : "processing",
      phase: "backfill",
      totalDocuments: "12",
    };
    if (path.endsWith("/ai-retrieval/reindex") || path.endsWith("/reindex/jobs/reindex-1"))
      return route.fulfill({ json: job });
    if (path.endsWith("/reindex/jobs/reindex-1/cancel")) {
      backend.cancelled = true;
      return route.fulfill({ json: { status: "cancelled" } });
    }
    return route.fulfill({ json: {} });
  });
  return backend;
}

function sanitizeKey<
  T extends { readonly apiKey?: string | null; readonly apiKeyConfigured?: boolean },
>(value: T, previous?: T) {
  const { apiKey, ...safe } = value;
  return {
    ...safe,
    apiKeyConfigured:
      apiKey === null ? false : typeof apiKey === "string" || previous?.apiKeyConfigured === true,
  };
}
