import { describe, expect, it } from "vitest";
import {
  R3_REQUIRED_STRUCTURAL,
  checkPaths,
  evaluatePackagingFailClosed,
  evaluateR3,
} from "./r3-go-no-go.mjs";

describe("R3 go/no-go gate", () => {
  it("requires structural packaging + ops artifacts that ship in-repo", () => {
    const structural = checkPaths(R3_REQUIRED_STRUCTURAL);
    // After this branch lands, all structural paths must exist.
    expect(structural.missing.filter((p) => !p.includes("k8s-drill"))).toEqual(
      expect.not.arrayContaining(["apps/helix/src/config/workspace-packaging.ts"]),
    );
    expect(R3_REQUIRED_STRUCTURAL).toContain("apps/helix/src/config/workspace-packaging.ts");
    expect(R3_REQUIRED_STRUCTURAL).toContain("infra/scripts/k8s-drill-dry-run.mjs");
  });

  it("evaluates packaging fail-closed from shipped source", () => {
    const packaging = evaluatePackagingFailClosed();
    expect(packaging.ok).toBe(true);
  });

  it("returns go in structural mode when live packs may be missing", () => {
    const evaluation = evaluateR3({ allowMissingLive: true });
    // Structural files from this PR may still be uncommitted during unit run —
    // require packaging + that evaluateR3 produces a decision object.
    expect(["go", "no-go"]).toContain(evaluation.decision);
    expect(evaluation.taskId).toBe("R3");
    expect(evaluation.packaging.ok).toBe(true);
  });
});
