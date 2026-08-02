import { describe, expect, it } from "vitest";
import {
  buildEvidence,
  evaluateHelmChartPresence,
  helmTemplateArgs,
  parseArgs,
} from "./k8s-drill-dry-run.mjs";

describe("k8s drill dry-run (O-K.15)", () => {
  it("defaults to dry-run mvp and builds helm args", () => {
    expect(parseArgs([])).toMatchObject({ dryRun: true, profile: "mvp" });
    expect(helmTemplateArgs("mvp").join(" ")).toContain("infra/helm/helix");
    expect(helmTemplateArgs("full").join(" ")).toContain("workspace.profile=full");
  });

  it("verifies chart presence on this repo (shipped files)", () => {
    const presence = evaluateHelmChartPresence();
    expect(presence.ok).toBe(true);
    expect(presence.missing).toEqual([]);
  });

  it("builds structured evidence without inventing live success", () => {
    const evidence = buildEvidence({
      dryRun: true,
      profile: "mvp",
      startedAt: "2026-08-02T00:00:00.000Z",
      finishedAt: "2026-08-02T00:00:01.000Z",
      chartPresent: { ok: true, missing: [] },
      helmTemplate: { ok: true, status: 0, skipped: true, args: [] },
      liveInstall: null,
      result: "pass",
      notes: ["dry-run"],
    });
    expect(evidence.taskId).toBe("O-K.15");
    expect(evidence.mode).toBe("dry-run");
    expect(evidence.liveInstall).toBeNull();
    expect(evidence.result).toBe("pass");
  });
});
