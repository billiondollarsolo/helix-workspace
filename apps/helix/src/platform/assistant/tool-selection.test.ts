import { describe, expect, it } from "vitest";
import { assistantToolGroups, filterToolGroups, selectedToolGroups } from "./tool-selection.js";
import type { AssistantVisibleTool } from "./types.js";

const tool = (id: string) => ({ id }) as AssistantVisibleTool;

describe("assistant tool groups", () => {
  it("keeps Meet, Administration, and Webhooks opt-in so defaults fit the tool limit", () => {
    // Default groups for a fully scoped member exceeded 128 tools once Meet tools
    // counted as "other", and every Assistant turn failed with "Too many tools".
    expect(selectedToolGroups()).toEqual([
      "mail",
      "chat",
      "drive",
      "calendar",
      "notifications",
      "other",
    ]);
    const tools = ["meet.create-room", "search.query", "mail.send"].map(tool);
    expect(filterToolGroups(tools).map((t) => t.id)).toEqual(["search.query", "mail.send"]);
    expect(filterToolGroups(tools, ["meet"]).map((t) => t.id)).toEqual(["meet.create-room"]);
    expect(assistantToolGroups(tools).groups.find((group) => group.id === "meet")).toMatchObject({
      label: "Meet",
      defaultEnabled: false,
      count: 1,
    });
  });
});
