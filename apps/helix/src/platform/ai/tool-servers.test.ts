import { describe, expect, it } from "vitest";
import {
  parseOpenApiTools,
  parsePrefixedToolId,
  prefixedToolId,
  visibleToolsFromServers,
} from "./tool-servers.js";

describe("external tool servers", () => {
  it("maps OpenAPI operations into a bounded assistant catalog", () => {
    const tools = parseOpenApiTools({
      paths: {
        "/customers/{id}": {
          get: { operationId: "lookup_customer", summary: "Lookup a customer" },
          post: { operationId: "create_customer", description: "Create a customer" },
        },
      },
    });
    expect(tools.map((tool) => tool.id)).toEqual(["lookup_customer", "create_customer"]);
    expect(tools[0]?.sideEffects).toBe("read");
    expect(tools[1]?.sideEffects).toBe("external_communication");
    const visible = visibleToolsFromServers([
      { id: "crm", type: "openapi", baseUrl: "https://crm.example", tools },
    ]);
    const first = visible[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.id).toBe(prefixedToolId("crm", "lookup_customer"));
    expect(parsePrefixedToolId(first.id)).toEqual({
      serverId: "crm",
      remoteId: "lookup_customer",
    });
  });
});
