import type { Actor, AiConfig, EventBus, JsonObject } from "@helix/sdk-types";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import {
  PlatformConfigAdminService,
  PostgresPlatformConfigStore,
  platformConfigUpdateSchema,
} from "./admin.js";
import {
  mergeAiSettingsPreservingSecrets,
  redactAiSecretsForAdmin,
  validateAiSettings,
} from "./ai-settings.js";
import { mergeConfig, subscribeToConfigHotReload } from "./loader.js";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { toJsonObject } from "../util/json.js";

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000100",
  type: "user",
  scopes: ["admin.config.write"],
};
const refs = ["vectorStore", "embeddingProvider"] as const;
function merged(current: AiConfig, patch: JsonObject) {
  return mergeAiSettingsPreservingSecrets(
    current,
    mergeConfig({ ai: current }, { ai: patch }).ai,
    patch,
  );
}

it("accepts finite Assistant tool limits and rejects invalid limits", () => {
  for (const maxToolRounds of [1, 16, 256])
    expect(
      platformConfigUpdateSchema.parse({ ai: { assistant: { maxToolRounds } } }).ai,
    ).toMatchObject({ assistant: { maxToolRounds } });
  for (const maxToolRounds of [0, -1, 257, 1.5, "16", null])
    expect(
      platformConfigUpdateSchema.safeParse({ ai: { assistant: { maxToolRounds } } }).success,
    ).toBe(false);
});

it("validates web search fields, caps counts, and rejects writable status flags", () => {
  expect(
    platformConfigUpdateSchema.parse({ ai: { webSearch: { enabled: false } } }).ai?.webSearch,
  ).toEqual({ enabled: false });
  expect(merged({}, { webSearch: { enabled: false } })?.webSearch?.maxResults).toBe(5);
  for (const webSearch of [
    { maxResults: 0 },
    { maxResults: 11 },
    { maxResults: 1.5 },
    { provider: "random" },
    { apiKeyConfigured: true },
  ])
    expect(platformConfigUpdateSchema.safeParse({ ai: { webSearch } }).success).toBe(false);
  expect(
    platformConfigUpdateSchema.parse({ ai: { webSearch: { apiKey: null } } }).ai?.webSearch?.apiKey,
  ).toBeNull();
});

it.each(refs)(
  "preserves and clears %s keys without changing credentials across endpoints",
  (field) => {
    const current = {
      [field]: {
        plugin: "qdrant",
        config: { baseUrl: "https://a.example", apiKey: "private-key", dimensions: 768 },
      },
    };
    for (const apiKey of [undefined, "", "   "]) {
      const patch = {
        [field]: {
          plugin: "qdrant",
          config: { dimensions: 384, ...(apiKey === undefined ? {} : { apiKey }) },
        },
      };
      expect(merged(current, patch)?.[field]?.config).toMatchObject({
        apiKey: "private-key",
        dimensions: 384,
      });
    }
    const changed = { plugin: "qdrant", config: { baseUrl: "https://b.example" } };
    expect(() => merged(current, { [field]: changed })).toThrow("Re-enter");
    expect(() => merged(current, { [field]: { plugin: "another" } })).toThrow("Re-enter");
    expect(
      merged(current, {
        [field]: { ...changed, config: { ...changed.config, apiKey: "replacement" } },
      })?.[field]?.config?.apiKey,
    ).toBe("replacement");
    expect(
      merged(current, { [field]: { ...changed, config: { ...changed.config, apiKey: null } } })?.[
        field
      ]?.config?.apiKey,
    ).toBe("");
  },
);

it("preserves web keys on ordinary edits, requires reentry on changed identity, and permits explicit clear", () => {
  const current: AiConfig = {
    webSearch: { enabled: true, provider: "brave", apiKey: "private-key", maxResults: 5 },
  };
  expect(merged(current, { webSearch: { maxResults: 3, apiKey: "" } })?.webSearch).toMatchObject({
    apiKey: "private-key",
    maxResults: 3,
  });
  expect(() =>
    merged(current, { webSearch: { provider: "searxng", baseUrl: "https://search.example" } }),
  ).toThrow("Re-enter");
  expect(
    merged(current, {
      webSearch: { provider: "searxng", baseUrl: "https://search.example", apiKey: null },
    })?.webSearch,
  ).toMatchObject({ apiKey: "", provider: "searxng" });
});

it("preserves a custom result count across parsed enable-only updates", () => {
  const patch = platformConfigUpdateSchema.parse({ ai: { webSearch: { enabled: false } } });
  expect(
    merged(
      {
        webSearch: {
          enabled: true,
          provider: "searxng",
          baseUrl: "https://search.example",
          maxResults: 9,
        },
      },
      toJsonObject(patch.ai ?? {}),
    )?.webSearch,
  ).toMatchObject({ enabled: false, maxResults: 9 });
});

it("reports explicit cleared credentials absent even with an inherited environment reference", () => {
  expect(
    redactAiSecretsForAdmin({
      security: { tier: "personal" },
      ai: {
        embeddingProvider: { plugin: "openai", config: { apiKey: "", apiKeyEnv: "LEGACY_KEY" } },
      },
    }).ai?.embeddingProvider?.config?.apiKeyConfigured,
  ).toBe(false);
});

it("does not move existing LLM credentials to a changed provider endpoint", () => {
  const current: AiConfig = {
    providers: [
      {
        id: "one",
        plugin: "openai",
        config: { baseUrl: "https://a.example", apiKey: "private-key" },
      },
    ],
  };
  expect(() =>
    merged(current, {
      providers: [{ id: "one", plugin: "openai", config: { baseUrl: "https://b.example" } }],
    }),
  ).toThrow("Re-enter");
});

it("does not forward legacy authorization headers when changing retrieval endpoints", () => {
  const current = {
    embeddingProvider: {
      plugin: "openai",
      config: { baseUrl: "https://first.example", headers: { Authorization: "private-key" } },
    },
  };
  expect(() =>
    merged(current, {
      embeddingProvider: { plugin: "openai", config: { baseUrl: "https://second.example" } },
    }),
  ).toThrow("Re-enter");
  expect(
    merged(current, {
      embeddingProvider: {
        plugin: "openai",
        config: { baseUrl: "https://second.example", apiKey: null },
      },
    })?.embeddingProvider?.config,
  ).toMatchObject({ apiKey: "", headers: null });
});

it("redacts every supported credential location and legacy headers/URL passwords", () => {
  const config = {
    apiKey: "private-key",
    apiKeyEnv: "PRIVATE_ENV_KEY",
    headers: { authorization: "private-header" },
    baseUrl: "https://user:private-password@search.example/path?key=private-query",
    nested: [{ token: "private-nested", safe: "label" }],
  };
  const output = redactAiSecretsForAdmin({
    security: { tier: "personal" },
    ai: {
      vectorStore: { plugin: "qdrant", config },
      embeddingProvider: { plugin: "openai", config },
      webSearch: { provider: "brave", apiKey: "private-web-key" },
    },
  });
  expect(JSON.stringify(output)).not.toMatch(/private-|PRIVATE_ENV_KEY/);
  expect(output.ai?.vectorStore?.config).toEqual({
    baseUrl: "https://search.example/path",
    nested: [{ safe: "label" }],
    apiKeyConfigured: true,
  });
  expect(output.ai?.embeddingProvider?.config?.apiKeyConfigured).toBe(true);
  expect(output.ai?.webSearch?.apiKeyConfigured).toBe(true);
});

it("validates retrieval credentials and partial chunk settings before the merged relationship", () => {
  for (const field of refs) {
    for (const config of [
      { apiKeyConfigured: false },
      { apiKeyEnv: "SECRET" },
      { headers: { authorization: "secret" } },
    ])
      expect(
        platformConfigUpdateSchema.safeParse({ ai: { [field]: { plugin: "openai", config } } })
          .success,
      ).toBe(false);
  }
  for (const maxInputChars of [0, 63, 32769, 200.5, "1024"])
    expect(
      platformConfigUpdateSchema.safeParse({
        ai: { embeddingProvider: { plugin: "openai", config: { maxInputChars } } },
      }).success,
    ).toBe(false);
  for (const maxInputChars of [64, 1024, 32768])
    expect(
      platformConfigUpdateSchema.safeParse({
        ai: { embeddingProvider: { plugin: "openai", config: { maxInputChars, apiKey: null } } },
      }).success,
    ).toBe(true);
  expect(
    platformConfigUpdateSchema.safeParse({
      ai: { embeddingProvider: { plugin: "openai", config: { chunkOverlapChars: 2048 } } },
    }).success,
  ).toBe(true);
  for (const chunkOverlapChars of [-1, 32768, 0.5, "64"])
    expect(
      platformConfigUpdateSchema.safeParse({
        ai: { embeddingProvider: { plugin: "openai", config: { chunkOverlapChars } } },
      }).success,
    ).toBe(false);
  expect(() => {
    validateAiSettings({
      embeddingProvider: {
        plugin: "openai",
        config: { maxInputChars: 4096, chunkOverlapChars: 2048 },
      },
    });
  }).not.toThrow();
  expect(() => {
    validateAiSettings({
      embeddingProvider: {
        plugin: "openai",
        config: { maxInputChars: 1024, chunkOverlapChars: 2048 },
      },
    });
  }).toThrow("overlap");
});

it("rejects embedding dimensions that the chosen vector backend cannot store", () => {
  for (const plugin of ["pgvector", "com.helix.vector-pgvector@^1.0.0"]) {
    expect(() => {
      validateAiSettings({
        vectorStore: { plugin },
        embeddingProvider: { plugin: "openai", config: { dimensions: 16001 } },
      });
    }).toThrow("16000");
    expect(() => {
      validateAiSettings({
        vectorStore: { plugin },
        embeddingProvider: { plugin: "openai", config: { dimensions: 16000 } },
      });
    }).not.toThrow();
  }
  expect(() => {
    validateAiSettings({
      vectorStore: { plugin: "qdrant" },
      embeddingProvider: { plugin: "openai", config: { dimensions: 65536 } },
    });
  }).not.toThrow();
});

it.each([
  "ftp://search.example",
  "https://user:secret@search.example",
  "https://search.example?key=secret",
  "https://search.example/#secret",
  "https://search.example/\\private",
])("rejects unsafe configured endpoints without reflecting the value: %s", (baseUrl) => {
  try {
    validateAiSettings({ webSearch: { provider: "searxng", enabled: true, baseUrl } });
    throw new Error("Unexpected success");
  } catch (error) {
    expect((error as Error).message).toContain("HTTP or HTTPS endpoint");
    expect((error as Error).message).not.toContain(baseUrl);
  }
});

it("checks enabled provider requirements while allowing saved disabled drafts", () => {
  expect(() => {
    validateAiSettings({ webSearch: { enabled: false } });
  }).not.toThrow();
  expect(() => {
    validateAiSettings({ webSearch: { enabled: true } });
  }).toThrow("Choose");
  expect(() => {
    validateAiSettings({ webSearch: { enabled: true, provider: "brave" } });
  }).toThrow("API key");
  expect(() => {
    validateAiSettings({ webSearch: { enabled: true, provider: "searxng" } });
  }).toThrow("endpoint");
});

it("persists masked settings across reload and leaves saved state unchanged when validation fails", async () => {
  const rows = new Map<string, unknown>();
  const db = createRecordingSql(({ text, values }) => {
    if (text.includes("select key, value"))
      return [...rows].map(([key, value]) => ({ key, value }));
    if (text.includes("insert into platform_config")) rows.set(String(values[0]), values[1]);
    return [];
  });
  const service = new PlatformConfigAdminService(new PostgresPlatformConfigStore(db.sql), {});
  const changed = vi.fn(async () => undefined);
  const patch = platformConfigUpdateSchema.parse({
    ai: { webSearch: { enabled: true, provider: "brave", apiKey: "private-key" } },
  });
  const result = await service.update(patch, actor, changed);
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({
      ai: expect.objectContaining({
        webSearch: expect.objectContaining({ apiKey: "private-key" }),
      }),
    }),
  );
  expect(result.config.ai?.webSearch).toEqual({
    enabled: true,
    provider: "brave",
    apiKeyConfigured: true,
    maxResults: 5,
  });
  expect(
    (await new PlatformConfigAdminService(new PostgresPlatformConfigStore(db.sql), {}).getStatus())
      .config,
  ).toEqual(result.config);
  const before = JSON.stringify([...rows]);
  await expect(
    service.update(
      platformConfigUpdateSchema.parse({
        ai: { webSearch: { provider: "searxng", baseUrl: "https://new.example" } },
      }),
      actor,
    ),
  ).rejects.toThrow("Re-enter");
  await expect(
    service.update(
      platformConfigUpdateSchema.parse({ ai: { webSearch: { maxResults: 2 } } }),
      actor,
      async () => {
        throw new Error("Rejected runtime");
      },
    ),
  ).rejects.toThrow("Rejected runtime");
  expect(JSON.stringify([...rows])).toBe(before);
  expect((await service.getStatus()).config.ai?.webSearch?.apiKeyConfigured).toBe(true);
});

it("publishes hot reload only after the config transaction commits, and never after a failed commit", async () => {
  let committed = false;
  let staged: unknown;
  let durable: unknown;
  const db = createRecordingSql(({ text, values }) => {
    if (text.includes("select key, value"))
      return durable === undefined ? [] : [{ key: "ai", value: durable }];
    if (text.includes("insert into platform_config")) staged = values[1];
    return [];
  });
  const publish = vi.fn(async () => {
    expect(committed).toBe(true);
    expect(durable).toMatchObject({ webSearch: { enabled: false } });
  });
  const events: EventBus = { publish, subscribe: async () => () => undefined };
  const service = new PlatformConfigAdminService(
    new PostgresPlatformConfigStore(db.sql),
    {},
    events,
  );
  await service.update(
    { ai: { webSearch: { enabled: false, maxResults: 5 } } },
    actor,
    undefined,
    async () => {
      durable = staged;
      committed = true;
    },
  );
  expect(publish).toHaveBeenCalledTimes(1);
  await expect(
    service.update({ ai: { webSearch: { maxResults: 3 } } }, actor, undefined, async () => {
      throw new Error("Commit failed");
    }),
  ).rejects.toThrow("Commit failed");
  expect(publish).toHaveBeenCalledTimes(1);
});

it("reloads in the subscriber context instead of inheriting a completed in-memory publisher transaction", async () => {
  const transaction = new AsyncLocalStorage<string>();
  const events = new InMemoryEventBus();
  const reload = vi.fn(async () => {
    expect(transaction.getStore()).toBeUndefined();
    return { security: { tier: "personal" as const } };
  });
  const applied = vi.fn();
  const unsubscribe = await subscribeToConfigHotReload({ events, reload, onReload: applied });
  await transaction.run("completed request", () => events.publish("helix.config.changed", {}));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(applied).toHaveBeenCalledWith({ security: { tier: "personal" } });
  await unsubscribe();
});

it("persists a validated credential clear over inherited environment configuration", async () => {
  const rows = new Map<string, unknown>();
  const db = createRecordingSql(({ text, values }) => {
    if (text.includes("select key, value"))
      return [...rows].map(([key, value]) => ({ key, value }));
    if (text.includes("insert into platform_config")) rows.set(String(values[0]), values[1]);
    return [];
  });
  const service = new PlatformConfigAdminService(new PostgresPlatformConfigStore(db.sql), {
    HELIX_CONFIG_JSON: JSON.stringify({
      ai: {
        embeddingProvider: {
          plugin: "openai",
          config: {
            baseUrl: "https://first.example",
            headers: { authorization: "private-key" },
            apiKeyEnv: "LEGACY_KEY",
          },
        },
      },
    }),
  });
  await service.update(
    platformConfigUpdateSchema.parse({
      ai: {
        embeddingProvider: {
          plugin: "openai",
          config: { baseUrl: "https://second.example", apiKey: null },
        },
      },
    }),
    actor,
  );
  expect(rows.get("ai")).toMatchObject({
    embeddingProvider: { config: { baseUrl: "https://second.example", apiKey: "", headers: null } },
  });
  expect(JSON.stringify(rows.get("ai"))).not.toContain("private-key");
});
