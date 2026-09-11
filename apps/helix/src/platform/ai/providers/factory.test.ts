import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AiConfig } from "@helix/sdk-types";
import { expect, it, vi } from "vitest";
import { createPlatformMetrics } from "../../../api/metrics.js";
import { InMemoryAICostLimiter } from "../costs/index.js";
import {
  configuredProviderFetch,
  createAssistantAIRouter,
  createAssistantProviders,
} from "./factory.js";

it("requires explicit opt-in before an AI provider can reach a private address", async () => {
  const server = createServer((_request, response) => response.end("local model"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    await expect(configuredProviderFetch(url, {})(url)).rejects.toMatchObject({
      code: "blocked_destination",
    });
    const response = await configuredProviderFetch(url, { HELIX_AI_ALLOW_PRIVATE_NETWORK: "true" })(
      url,
    );
    expect(await response.text()).toBe("local model");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

it("refreshes saved model choices and routing without restarting or inventing an AI reply", async () => {
  let model = "first/model";
  const server = createServer((_request, response) =>
    response.end(JSON.stringify({ choices: [{ message: { content: model } }], model })),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
  vi.stubEnv("HELIX_AI_ALLOW_PRIVATE_NETWORK", "true");
  vi.stubEnv("OPENAI_API_KEY", "bootstrap-key-must-not-add-a-shadow-provider");
  const config = (): AiConfig => ({
    enabled: true,
    providers: [
      {
        id: "saved",
        plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
        tags: ["assistant"],
        config: { baseUrl, models: [model], defaultModel: model },
      },
    ],
    routing: { rules: [{ feature: "assistant.chat", primary: { providerId: "saved", model } }] },
  });
  let current = config();
  const ai = createAssistantAIRouter(
    { record: async () => ({ id: "test-provenance" }) },
    {
      getAiConfig: () => current,
      securityTier: "personal",
      costLimiter: new InMemoryAICostLimiter(),
      metrics: createPlatformMetrics(),
    },
  );
  try {
    expect(createAssistantProviders(current).map((provider) => provider.id)).toEqual(["saved"]);
    expect((await ai.listModels()).defaultModelId).toBe("saved/first/model");
    expect(
      (await ai.chat({ feature: "assistant.chat", messages: [{ role: "user", content: "hi" }] }))
        .message,
    ).toBe("first/model");
    model = "second/model";
    current = config();
    expect((await ai.listModels()).models.map((entry) => entry.id)).toEqual(["saved/second/model"]);
    expect(
      (await ai.chat({ feature: "assistant.chat", messages: [{ role: "user", content: "hi" }] }))
        .message,
    ).toBe("second/model");
    current = {
      ...current,
      providers: current.providers?.map((provider) => ({ ...provider, tags: ["backend"] })) ?? [],
    };
    expect((await ai.listModels()).models).toEqual([]);
    current = { enabled: false };
    expect((await ai.listModels()).models).toEqual([]);
    await expect(
      ai.chat({ feature: "assistant.chat", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/No AI provider/);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
