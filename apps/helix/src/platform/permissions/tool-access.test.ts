import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { ALL_SCOPES } from "./scope-catalog.js";
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
    id: "mail.read",
    description: "Visible",
    inputSchema: schema,
    outputSchema: schema,
    permission: "mail.read",
    sideEffects: "read",
    handler: async () => ({}),
  },
  {
    id: "mail.write",
    description: "Hidden",
    inputSchema: schema,
    outputSchema: schema,
    permission: "mail.write",
    sideEffects: "write",
    handler: async () => ({}),
  },
];

describe("filterToolsForActor", () => {
  it("enforces the complete permission matrix and rejects unknown actions", async () => {
    const policy = new ScopeToolAccessPolicy();
    for (const permission of ALL_SCOPES) {
      await expect(policy.can(agent([permission]), permission)).resolves.toBe(true);
      await expect(policy.can(agent([]), permission)).resolves.toBe(false);
    }
    await expect(policy.can(agent(["invented.admin"]), "invented.admin")).resolves.toBe(false);
  });

  it("filters tools by actor scopes", async () => {
    const filtered = await filterToolsForActor(
      tools,
      {
        id: "agent-1",
        orgId: "org-1",
        type: "agent",
        scopes: ["mail.read"],
      },
      new ScopeToolAccessPolicy(),
    );

    expect(filtered.map((tool) => tool.id)).toEqual(["mail.read"]);
  });

  it("consumes exact role grants and deny precedence", async () => {
    const policy = new ScopeToolAccessPolicy();
    const actor: Actor = {
      id: "agent-1",
      orgId: "org-1",
      type: "agent",
      scopes: ["mail.write"],
      roleBindings: [
        {
          roleId: "00000000-0000-4000-8000-000000000001",
          allow: ["mail.read"],
          deny: ["mail.write"],
          scope: { type: "resource", resourceType: "tool", id: "mail.read" },
        },
      ],
    };

    await expect(policy.can(actor, "mail.read", toolResourceForTest(firstTool()))).resolves.toBe(
      true,
    );
    await expect(
      policy.can(
        actor,
        "mail.write",
        toolResourceForTest({ ...firstTool(), id: "mail.read", permission: "mail.write" }),
      ),
    ).resolves.toBe(false);
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

    expect(filtered.map((tool) => tool.id)).toEqual(["mail.read", "mail.write"]);
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
                "mail.read": "EFFECT_ALLOW",
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
          scopes: ["mail.read"],
        },
        "mail.read",
        toolResourceForTest(firstTool()),
      ),
    ).resolves.toBe(true);

    expect(requests).toEqual([
      {
        requestId: "helix-tool-access:org-1:agent-1:mail.read",
        principal: {
          id: "agent-1",
          roles: ["agent"],
          attr: {
            org_id: "org-1",
            type: "agent",
            scopes: ["mail.read"],
          },
        },
        resources: [
          {
            resource: {
              id: "mail.read",
              kind: "tool",
              attr: {
                org_id: "org-1",
                permission: "mail.read",
                sideEffects: "read",
              },
            },
            actions: ["mail.read"],
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
          scopes: ["mail.read"],
        },
        "mail.read",
        toolResourceForTest(firstTool()),
      ),
    ).resolves.toBe(false);
  });

  it("rejects unknown actions before consulting Cerbos", async () => {
    let called = false;
    const policy = new CerbosToolAccessPolicy({
      endpoint: "http://cerbos.local",
      fetch: async () => {
        called = true;
        return Response.json({ results: [{ actions: { "invented.admin": "EFFECT_ALLOW" } }] });
      },
    });

    await expect(
      policy.can(agent(["invented.admin"]), "invented.admin", { type: "tool" }),
    ).resolves.toBe(false);
    expect(called).toBe(false);
  });

  it("does not promote a narrow admin scope to an omnipotent Cerbos role", async () => {
    let requestBody: unknown;
    const policy = new CerbosToolAccessPolicy({
      endpoint: "http://cerbos.local",
      fetch: async (_input, init) => {
        requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ results: [{ actions: { "drive.delete": "EFFECT_DENY" } }] });
      },
    });

    await expect(
      policy.can(
        { id: "auditor", orgId: "org-1", type: "user", scopes: ["admin.audit"] },
        "drive.delete",
        toolResourceForTest({ ...firstTool(), permission: "drive.delete" }),
      ),
    ).resolves.toBe(false);
    expect(requestBody).toMatchObject({ principal: { roles: ["user"] } });
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
          scopes: ["mail.read"],
        },
        "mail.read",
        toolResourceForTest(firstTool()),
      ),
    ).resolves.toBe(false);

    expect(metrics.records).toEqual([
      expect.objectContaining({
        action: "mail.read",
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
    expect(requiredScopesForCall(firstTool(), {})).toEqual(["mail.read"]);
  });

  it("includes unconditional required scopes", () => {
    const tool: ToolDefinition = {
      ...firstTool(),
      scopeComposition: { requiredScopes: ["extra.scope"] },
    };
    expect(requiredScopesForCall(tool, {})).toEqual(["mail.read", "extra.scope"]);
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

  it("rejects unknown permissions even when the actor claims them", () => {
    const tool = { ...firstTool(), permission: "invented.admin" };
    expect(checkScopeComposition(agent(["invented.admin"]), tool, {})).toEqual({
      ok: false,
      missingScopes: ["invented.admin"],
    });
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
