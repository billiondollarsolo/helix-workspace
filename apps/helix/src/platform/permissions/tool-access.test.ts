import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import {
  CerbosToolAccessPolicy,
  ObservedToolAccessPolicy,
  ScopeToolAccessPolicy,
  checkScopeComposition,
  filterToolsForActor,
  requiredScopesForCall,
  type PermissionCheckMetrics,
} from "./tool-access.js";

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({}),
};

const tools: readonly ToolDefinition[] = [
  {
    id: "visible.read",
    description: "Visible",
    inputSchema: schema,
    outputSchema: schema,
    permission: "visible.read",
    sideEffects: "read",
    handler: async () => ({}),
  },
  {
    id: "hidden.write",
    description: "Hidden",
    inputSchema: schema,
    outputSchema: schema,
    permission: "hidden.write",
    sideEffects: "write",
    handler: async () => ({}),
  },
];

describe("filterToolsForActor", () => {
  it("filters tools by actor scopes", async () => {
    const filtered = await filterToolsForActor(
      tools,
      {
        id: "agent-1",
        orgId: "org-1",
        type: "agent",
        scopes: ["visible.read"],
      },
      new ScopeToolAccessPolicy(),
    );

    expect(filtered.map((tool) => tool.id)).toEqual(["visible.read"]);
  });

  it("allows system actors to see every tool", async () => {
    const filtered = await filterToolsForActor(
      tools,
      {
        id: "system",
        orgId: "org-1",
        type: "system",
      },
      new ScopeToolAccessPolicy(),
    );

    expect(filtered.map((tool) => tool.id)).toEqual(["visible.read", "hidden.write"]);
  });

  it("checks tool permissions through Cerbos when configured", async () => {
    const requests: unknown[] = [];
    const policy = new CerbosToolAccessPolicy({
      endpoint: "http://cerbos.local/",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected Cerbos request body to be JSON.");
        }
        requests.push(JSON.parse(init.body));
        return Response.json({
          results: [
            {
              actions: {
                "visible.read": "EFFECT_ALLOW",
              },
            },
          ],
        });
      },
    });

    await expect(
      policy.can(
        {
          id: "agent-1",
          orgId: "org-1",
          type: "agent",
          scopes: ["visible.read"],
        },
        "visible.read",
        toolResourceForTest(firstTool()),
      ),
    ).resolves.toBe(true);

    expect(requests).toEqual([
      {
        requestId: "helix-tool-access:org-1:agent-1:visible.read",
        principal: {
          id: "agent-1",
          roles: ["agent"],
          attr: {
            org_id: "org-1",
            type: "agent",
            scopes: ["visible.read"],
          },
        },
        resources: [
          {
            resource: {
              id: "visible.read",
              kind: "tool",
              attr: {
                org_id: "org-1",
                permission: "visible.read",
                sideEffects: "read",
              },
            },
            actions: ["visible.read"],
          },
        ],
      },
    ]);
  });

  it("fails closed when Cerbos cannot return a decision", async () => {
    const policy = new CerbosToolAccessPolicy({
      endpoint: "http://cerbos.local",
      fetch: async () => new Response("nope", { status: 503 }),
    });

    await expect(
      policy.can(
        {
          id: "agent-1",
          orgId: "org-1",
          type: "agent",
          scopes: ["visible.read"],
        },
        "visible.read",
        toolResourceForTest(firstTool()),
      ),
    ).resolves.toBe(false);
  });

  it("records observed permission decisions and fails closed on policy errors", async () => {
    const metrics = new FakePermissionMetrics();
    const policy = new ObservedToolAccessPolicy(
      {
        can: async () => {
          throw new Error("pdp unavailable");
        },
      },
      { metrics, policyId: "test-pdp" },
    );

    await expect(
      policy.can(
        {
          id: "agent-1",
          orgId: "org-1",
          type: "agent",
          scopes: ["visible.read"],
        },
        "visible.read",
        toolResourceForTest(firstTool()),
      ),
    ).resolves.toBe(false);

    expect(metrics.records).toEqual([
      expect.objectContaining({
        action: "visible.read",
        actorType: "agent",
        decision: "error",
        policy: "test-pdp",
        resourceType: "tool",
      }),
    ]);
  });
});

const externalMailTool: ToolDefinition = {
  id: "mail.send",
  description: "Send mail",
  inputSchema: schema,
  outputSchema: schema,
  permission: "mail.send",
  sideEffects: "external_communication",
  scopeComposition: {
    conditionalScopes: [
      {
        scope: "mail.external",
        reason: "external recipient",
        when: (input) => {
          const recipients = (input as { to?: readonly { address: string }[] }).to ?? [];
          return recipients.some((entry) => !entry.address.endsWith("@internal.test"));
        },
      },
    ],
  },
  handler: async () => ({}),
};

function agent(scopes: readonly string[]): Actor {
  return { id: "agent-1", orgId: "org-1", type: "agent", scopes };
}

describe("requiredScopesForCall", () => {
  it("returns only the base permission when no composition is declared", () => {
    expect(requiredScopesForCall(firstTool(), {})).toEqual(["visible.read"]);
  });

  it("includes unconditional required scopes", () => {
    const tool: ToolDefinition = {
      ...firstTool(),
      scopeComposition: { requiredScopes: ["extra.scope"] },
    };
    expect(requiredScopesForCall(tool, {})).toEqual(["visible.read", "extra.scope"]);
  });

  it("adds a conditional scope only when its predicate matches the input", () => {
    expect(
      requiredScopesForCall(externalMailTool, { to: [{ address: "bob@internal.test" }] }),
    ).toEqual(["mail.send"]);
    expect(
      requiredScopesForCall(externalMailTool, { to: [{ address: "bob@partner.com" }] }),
    ).toEqual(["mail.send", "mail.external"]);
  });

  it("fails closed when a conditional predicate throws", () => {
    const tool: ToolDefinition = {
      ...firstTool(),
      scopeComposition: {
        conditionalScopes: [
          {
            scope: "danger.scope",
            reason: "unparseable input",
            when: () => {
              throw new Error("bad input");
            },
          },
        ],
      },
    };
    expect(requiredScopesForCall(tool, {})).toContain("danger.scope");
  });
});

describe("checkScopeComposition", () => {
  it("passes system actors unconditionally", () => {
    const result = checkScopeComposition(
      { id: "system", orgId: "org-1", type: "system" },
      externalMailTool,
      { to: [{ address: "bob@partner.com" }] },
    );
    expect(result).toEqual({ ok: true });
  });

  it("allows an internal-only send with just mail.send", () => {
    const result = checkScopeComposition(agent(["mail.send"]), externalMailTool, {
      to: [{ address: "bob@internal.test" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("denies an external send when the actor lacks mail.external", () => {
    const result = checkScopeComposition(agent(["mail.send"]), externalMailTool, {
      to: [{ address: "bob@partner.com" }],
    });
    expect(result).toEqual({ ok: false, missingScopes: ["mail.external"] });
  });

  it("allows an external send when the actor holds mail.external", () => {
    const result = checkScopeComposition(agent(["mail.send", "mail.external"]), externalMailTool, {
      to: [{ address: "bob@partner.com" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("reports every missing scope, including the base permission", () => {
    const result = checkScopeComposition(agent([]), externalMailTool, {
      to: [{ address: "bob@partner.com" }],
    });
    expect(result).toEqual({ ok: false, missingScopes: ["mail.send", "mail.external"] });
  });
});

class FakePermissionMetrics implements PermissionCheckMetrics {
  readonly records: Parameters<PermissionCheckMetrics["recordPermissionCheck"]>[0][] = [];

  recordPermissionCheck(input: Parameters<PermissionCheckMetrics["recordPermissionCheck"]>[0]) {
    this.records.push(input);
  }
}

function firstTool(): ToolDefinition {
  const tool = tools[0];
  if (tool === undefined) {
    throw new Error("Expected a test tool.");
  }
  return tool;
}

function toolResourceForTest(tool: ToolDefinition) {
  return {
    type: "tool",
    id: tool.id,
    attributes: {
      permission: tool.permission,
      sideEffects: tool.sideEffects,
    },
  };
}
