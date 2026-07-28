import { describe, expect, it } from "vitest";
import { resolveEffectiveClassification } from "./effective.js";

describe("resolveEffectiveClassification", () => {
  it("does not allow a public client hint to lower confidential server context", () => {
    expect(
      resolveEffectiveClassification({
        orgId: "org-1",
        clientHint: "public",
        contexts: [
          {
            id: "mail-1",
            kind: "retrieved_source",
            orgId: "org-1",
            classification: "confidential",
          },
        ],
      }).classification,
    ).toBe("confidential");
  });

  it("chooses the maximum across mixed context and lets a client raise classification", () => {
    expect(
      resolveEffectiveClassification({
        orgId: "org-1",
        clientHint: "restricted",
        userInputClassification: "public",
        contexts: [
          { id: "conversation-1", kind: "conversation", classification: "standard" },
          { id: "memory-1", kind: "memory", classification: "confidential" },
        ],
      }).classification,
    ).toBe("restricted");
  });

  it("conservatively treats missing context classification as restricted", () => {
    const resolution = resolveEffectiveClassification({
      orgId: "org-1",
      contexts: [{ id: "tool-1", kind: "tool_result", orgId: "org-1" }],
    });

    expect(resolution.classification).toBe("restricted");
    expect(resolution.contributors.at(-1)).toMatchObject({
      id: "tool-1",
      classification: "restricted",
      defaulted: true,
    });
  });

  it("rejects cross-organization context instead of allowing it into classification", () => {
    const resolution = resolveEffectiveClassification({
      orgId: "org-1",
      contexts: [
        {
          id: "foreign-source",
          kind: "retrieved_source",
          orgId: "org-2",
          classification: "restricted",
        },
      ],
    });

    expect(resolution.classification).toBe("standard");
    expect(resolution.rejectedCrossOrgContextIds).toEqual(["foreign-source"]);
    expect(resolution.contributors).toHaveLength(1);
  });
});
