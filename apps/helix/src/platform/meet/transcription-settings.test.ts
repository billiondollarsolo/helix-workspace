import { describe, expect, it } from "vitest";
import type { HelixConfig } from "@helix/sdk-types";
import { meetTranscriptionSettings } from "./transcription-settings.js";

const config: HelixConfig = {
  security: { tier: "business" },
  ai: {
    providers: [
      {
        id: "speech",
        plugin: "openai-compat",
        config: {
          apiKey: "speech-secret",
          baseUrl: "https://speech.example/v1",
          realtimeTranscription: true,
          models: ["speech-a", "speech-b"],
          defaultModel: "speech-a",
        },
      },
      {
        id: "recap",
        plugin: "anthropic-compatible",
        config: { apiKey: "recap-secret", models: ["text-a"] },
      },
    ],
    routing: {
      rules: [
        { feature: "meet.transcribe", primary: { providerId: "speech", model: "speech-b" } },
        { feature: "meet.summarize", primary: { providerId: "recap", model: "text-a" } },
      ],
    },
  },
};
const both = { meet_transcription: true, meet_ai_recaps: true };
const settings = (
  value = config,
  flags: Record<string, boolean> | undefined = both,
  proxy = true,
) => meetTranscriptionSettings(value, flags, proxy, ["speech.example"]);

describe("independent Meet AI settings", () => {
  it("defaults both features off without returning speech credentials", () => {
    expect(meetTranscriptionSettings(config, undefined, true, ["speech.example"])).toEqual({
      enabled: false,
      summarize: false,
    });
  });
  it("uses the explicitly selected speech model and credentials, independently of the summary provider", () => {
    expect(settings()).toEqual({
      enabled: true,
      summarize: true,
      model: "speech-b",
      apiKey: "speech-secret",
      endpoint: "wss://speech.example/v1/realtime?intent=transcription",
    });
    expect(settings(config, { meet_transcription: true }).summarize).toBe(false);
    expect(settings(config, { meet_ai_recaps: true })).toEqual({ enabled: false, summarize: true });
  });
  it("requires the deployed proxy and an allowlisted endpoint", () => {
    expect(settings(config, both, false).enabled).toBe(false);
    expect(meetTranscriptionSettings(config, both, true).enabled).toBe(false);
  });
  it.each([
    "http://speech.example/v1",
    "https://user:password@speech.example/v1",
    "https://speech.example:444/v1",
    "https://speech.example/v1?key=secret",
    "https://speech.example/v1#key",
    "invalid",
  ])("rejects unsafe endpoint %s", (baseUrl) => {
    expect(
      settings({
        ...config,
        ai: {
          ...config.ai,
          providers: (config.ai?.providers ?? []).map((provider) => ({
            ...provider,
            config: { ...provider.config, baseUrl },
          })),
        },
      }).enabled,
    ).toBe(false);
  });
  it.each(["sovereign", "business"] as const)("honors local-only policy in %s", (tier) => {
    expect(
      settings({ ...config, security: { tier, overrides: { localAiOnly: true } } }).enabled,
    ).toBe(false);
  });
  it("does not borrow default models or the Assistant route", () => {
    for (const rules of [
      [],
      [{ feature: "assistant.chat", primary: { providerId: "speech", model: "speech-a" } }],
      [{ feature: "meet.transcribe", primary: { providerId: "speech" } }],
    ]) {
      expect(settings({ ...config, ai: { ...config.ai, routing: { rules } } })).toEqual({
        enabled: false,
        summarize: false,
      });
    }
  });
  it("honors global and provider disablement", () => {
    expect(settings({ ...config, ai: { ...config.ai, enabled: false } })).toEqual({
      enabled: false,
      summarize: false,
    });
    expect(
      settings({
        ...config,
        ai: {
          ...config.ai,
          providers: (config.ai?.providers ?? []).map((provider) => ({
            ...provider,
            enabled: false,
          })),
        },
      }),
    ).toEqual({ enabled: false, summarize: false });
  });
  it("requires declared speech compatibility and a configured model", () => {
    for (const patch of [
      { realtimeTranscription: false },
      { models: ["another-model"] },
      { apiKey: "" },
    ]) {
      expect(
        settings({
          ...config,
          ai: {
            ...config.ai,
            providers: (config.ai?.providers ?? []).map((provider) => ({
              ...provider,
              config: { ...provider.config, ...patch },
            })),
          },
        }).enabled,
      ).toBe(false);
    }
  });
});
