import { describe, expect, it } from "vitest";
import {
  assertDeploymentResidency,
  assertRegionalDatabase,
  regionalResourceName,
} from "./residency.js";

const regional = {
  region: "us-east-1",
  storageRegion: "us-east-1",
  production: true,
  telemetryEnabled: true,
  telemetryRegion: "us-east-1",
} as const;

describe("deployment residency", () => {
  it("accepts one consistently placed regional deployment", () => {
    expect(() => {
      assertDeploymentResidency({
        ...regional,
        searchIndexUid: "us-east-1_helix_search",
        ai: {
          providers: [{ id: "bedrock", plugin: "bedrock", config: { region: "us-east-1" } }],
          embeddingProvider: {
            plugin: "openai-compatible",
            config: { baseUrl: "http://embeddings.ai.svc:8080" },
          },
        },
      });
    }).not.toThrow();
    expect(regionalResourceName("us-east-1", "helix_search")).toBe("us-east-1_helix_search");
  });

  it.each([
    [{ ...regional, storageRegion: "eu-west-1" }, /object storage region/u],
    [{ ...regional, searchIndexUid: "helix_search" }, /Search index/u],
    [{ ...regional, telemetryRegion: undefined }, /telemetry collector/u],
    [{ ...regional, openAiApiKey: "secret" }, /no residency declaration/u],
    [
      {
        ...regional,
        ai: { providers: [{ id: "bedrock", plugin: "bedrock", config: { region: "eu-west-1" } }] },
      },
      /AI plugin/u,
    ],
  ])("fails closed for a processor outside the deployment region", (input, message) => {
    expect(() => {
      assertDeploymentResidency(input);
    }).toThrow(message);
  });

  it("fails boot when the physical database contains another region", async () => {
    const sql = (() => [{ region: "eu-west-1", tenant_count: 2 }]) as never;
    await expect(assertRegionalDatabase(sql, "us-east-1")).rejects.toThrow(/eu-west-1 \(2\)/u);
  });
});
