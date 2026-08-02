import { describe, expect, it, vi } from "vitest";
import { getAgentOperationalControls, setAgentOperationalControls } from "./agent-controls-api";

describe("agent controls admin API (A10)", () => {
  it("loads controls via admin.agent_controls.get", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("admin.agent_controls.get");
      return new Response(
        JSON.stringify({
          controls: {
            globalReadOnly: false,
            agentWritesEnabled: true,
            agentWritesDisabledOrgIds: ["org-a"],
            disabledToolIds: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const controls = await getAgentOperationalControls(fetchImpl as never);
    expect(controls.agentWritesDisabledOrgIds).toEqual(["org-a"]);
  });

  it("sets emergency kill via admin.agent_controls.set", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/approve")) {
        return new Response(
          JSON.stringify({
            controls: {
              globalReadOnly: true,
              agentWritesEnabled: true,
              agentWritesDisabledOrgIds: [],
              disabledToolIds: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url).toContain("admin.agent_controls.set");
      const body = JSON.parse(String(init?.body ?? "{}")) as { globalReadOnly?: boolean };
      expect(body.globalReadOnly).toBe(true);
      return new Response(
        JSON.stringify({
          status: "pending_confirmation",
          pending: { id: "pending-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const controls = await setAgentOperationalControls(
      { globalReadOnly: true },
      fetchImpl as never,
    );
    expect(controls.globalReadOnly).toBe(true);
  });
});
