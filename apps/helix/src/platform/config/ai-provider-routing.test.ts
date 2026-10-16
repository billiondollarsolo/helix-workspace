import { expect, it } from "vitest";
import { operatorAiEnvFromConfig } from "./ai-settings.js";

it("never exports native-provider credentials to chat-completions consumers", () => {
  const overlay = operatorAiEnvFromConfig({
    security: { tier: "business" },
    ai: {
      providers: [
        {
          id: "claude",
          plugin: "anthropic-compatible",
          config: {
            baseUrl: "https://api.anthropic.com/v1",
            apiKey: "native-secret",
            defaultModel: "native-model",
          },
        },
      ],
      routing: {
        rules: ["assistant.chat", "mail.spam-ai", "mail.compose-help"].map((feature) => ({
          feature,
          primary: { providerId: "claude" },
        })),
      },
    },
  });
  expect(JSON.stringify(overlay)).not.toContain("native-secret");
  expect(overlay.OPENAI_API_KEY).toBe("");
  expect(overlay.MAIL_SPAM_AI_API_KEY).toBe("");
  expect(overlay.MAIL_ASSIST_AI_API_KEY).toBe("");
});

it("does not borrow a different provider's key or endpoint for the spam route", () => {
  const overlay = operatorAiEnvFromConfig({
    security: { tier: "business" },
    ai: {
      operatorLlm: {
        baseUrl: "https://chat.example/v1",
        apiKey: "chat-secret",
        model: "chat-model",
      },
      providers: [
        {
          id: "spam",
          plugin: "openai-compat",
          config: { baseUrl: "https://spam.example/v1", defaultModel: "spam-model" },
        },
      ],
      routing: { rules: [{ feature: "mail.spam-ai", primary: { providerId: "spam" } }] },
    },
  });
  expect(overlay.MAIL_SPAM_AI_API_KEY).toBe("");
  expect(overlay.MAIL_SPAM_AI_BASE_URL).not.toBe("https://chat.example/v1");
});
