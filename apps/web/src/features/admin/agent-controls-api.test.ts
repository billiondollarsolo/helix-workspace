import { describe, expect, it, vi } from "vitest";
import { getAgentOperationalControls, setAgentOperationalControls } from "./agent-controls-api";
import type { ToolFetch } from "@/lib/tool-call";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function bodyOf(init?: RequestInit): string {
  if (init?.body === undefined || init.body === null) {
    return "{}";
  }
  if (typeof init.body === "string") {
    return init.body;
  }
  return "{}";
}

describe("agent controls admin API (A10)", () => {
  it("loads controls via admin.agent_controls.get", async () => {
    const fetchImpl: ToolFetch = vi.fn((input: RequestInfo | URL) => {
      expect(urlOf(input)).toContain("admin.agent_controls.get");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            controls: {
              globalReadOnly: false,
              agentWritesEnabled: true,
              agentWritesDisabledOrgIds: ["org-a"],
              disabledToolIds: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const controls = await getAgentOperationalControls(fetchImpl);
    expect(controls.agentWritesDisabledOrgIds).toEqual(["org-a"]);
  });

  it("sets emergency kill via admin.agent_controls.set", async () => {
    const fetchImpl: ToolFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/approve")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              controls: {
                globalReadOnly: true,
                agentWritesEnabled: true,
                agentWritesDisabledOrgIds: [],
                disabledToolIds: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      expect(url).toContain("admin.agent_controls.set");
      const body = JSON.parse(bodyOf(init)) as { globalReadOnly?: boolean };
      expect(body.globalReadOnly).toBe(true);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "pending_confirmation",
            pending: { id: "pending-1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const controls = await setAgentOperationalControls({ globalReadOnly: true }, fetchImpl);
    expect(controls.globalReadOnly).toBe(true);
  });
});
