import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "./registry.js";

const noopFormat = {
  id: "fmt",
  render: () => ({ contentType: "application/json", body: {} }) as const,
};

describe("ConnectorRegistry", () => {
  it("registers and retrieves webhook formats and sources", () => {
    const registry = new ConnectorRegistry();
    registry.registerWebhookFormat(noopFormat);
    registry.registerWebhookSource({ id: "src", verify: () => true });

    expect(registry.getWebhookFormat("fmt")).toBe(noopFormat);
    expect(registry.getWebhookSource("src")?.id).toBe("src");
    expect(registry.webhookFormats()).toHaveLength(1);
    expect(registry.webhookSources()).toHaveLength(1);
  });

  it("rejects a duplicate webhook format id", () => {
    const registry = new ConnectorRegistry();
    registry.beginConnector("connector.a");
    registry.registerWebhookFormat(noopFormat);
    registry.endConnector();
    registry.beginConnector("connector.b");
    expect(() => {
      registry.registerWebhookFormat(noopFormat);
    }).toThrow(/already registered/u);
  });

  it("rejects a duplicate webhook source id", () => {
    const registry = new ConnectorRegistry();
    registry.registerWebhookSource({ id: "src", verify: () => true });
    expect(() => {
      registry.registerWebhookSource({ id: "src", verify: () => false });
    }).toThrow(/already registered/u);
  });
});
