import { describe, expect, it } from "vitest";
import { assistantRequestError, toolLimitSummary } from "./tool-limit";

const details = {
  limit: 128,
  selected: 143,
  excess: 15,
  groups: [
    { id: "admin", label: "Administration", count: 40 },
    { id: "webhooks", label: "Webhooks", count: 12 },
  ],
};

describe("assistant tool-limit errors", () => {
  it("reads the remedy from a REST error envelope", () => {
    const error = assistantRequestError(
      {
        error: {
          code: "assistant_tool_limit_exceeded",
          message: "The selected tool groups include 143 tools.",
          details,
        },
      },
      "fallback",
    );
    expect(error.code).toBe("assistant_tool_limit_exceeded");
    expect(error.message).toBe("The selected tool groups include 143 tools.");
    expect(error.toolLimit).toEqual(details);
    expect(toolLimitSummary(details)).toBe("Too many tool groups are on (143 of 128 tools).");
  });

  it("reads the remedy from a streamed error frame", () => {
    const error = assistantRequestError(
      { type: "error", message: "Too many", code: "assistant_tool_limit_exceeded", details },
      "fallback",
    );
    expect(error.toolLimit?.groups.map((group) => group.id)).toEqual(["admin", "webhooks"]);
  });

  it("keeps other failures plain", () => {
    const error = assistantRequestError({ type: "error", message: "The stream failed." }, "x");
    expect(error.message).toBe("The stream failed.");
    expect(error.toolLimit).toBeUndefined();
    expect(assistantRequestError({}, "Assistant chat failed with 500").message).toBe(
      "Assistant chat failed with 500",
    );
  });
});
