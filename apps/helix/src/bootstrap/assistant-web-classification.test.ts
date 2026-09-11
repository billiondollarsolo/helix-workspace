import type { Actor } from "@helix/sdk-types";
import { expect, it } from "vitest";
import { createAssistantToolResultClassifier } from "./assistant-tool-classification.js";

const actor: Actor = { id: "actor", orgId: "org", type: "user" };
const classify = createAssistantToolResultClassifier({ get: async () => null });
const result = (snippet: string) => ({
  provider: "searxng",
  results: [
    {
      id: "web-1",
      title: "Gaithersburg hourly weather",
      url: "https://www.accuweather.com/en/us/gaithersburg/20877/september-weather/333568",
      snippet,
    },
  ],
});

it("classifies the real public weather calendar snippet without inventing a payment card", async () => {
  const output = result(
    "Today 1 2 3 4 5 6 7 *8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30. Avg. Hi. Avg. Lo. Actual Hi. Actual Lo. Forecast Hi. Forecast Lo.",
  );
  await expect(classify({ actor, toolId: "web.search", output })).resolves.toBe("standard");
});

it.each([
  ["Alligator attacks child swimming in restricted Florida waters", "standard"],
  ["RESTRICTED", "restricted"],
  ["Classification: confidential", "confidential"],
  ["api_key=private_test_value_123456", "restricted"],
  ["SSN 123-45-6789", "confidential"],
  ["Card 4111 1111 1111 1111", "confidential"],
])("retains true sensitivity in public results: %s", async (snippet, expected) => {
  await expect(classify({ actor, toolId: "web.search", output: result(snippet) })).resolves.toBe(
    expected,
  );
});

it("preserves server-owned full-page classification even when preview text is ordinary", async () => {
  await expect(
    classify({
      actor,
      toolId: "web.fetch",
      output: {
        url: "https://example.com/weather",
        title: "Forecast",
        contentType: "text/html",
        content: "Warm and sunny",
        offset: 0,
        nextOffset: 14,
        totalChars: 6000,
        truncated: true,
        classification: "restricted",
      },
    }),
  ).resolves.toBe("restricted");
});
