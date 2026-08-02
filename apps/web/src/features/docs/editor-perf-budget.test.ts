import { describe, expect, it } from "vitest";
import {
  EDITOR_PERF_BUDGETS,
  evaluateEditorOpenBudget,
  requiresProgressiveLoad,
} from "./editor-perf-budget";

describe("editor perf budgets (ED.10)", () => {
  it("exports concrete budgets for docs/sheets/slides", () => {
    expect(EDITOR_PERF_BUDGETS.docs.openInteractiveHardMs).toBeGreaterThan(
      EDITOR_PERF_BUDGETS.docs.openInteractiveMs,
    );
    expect(EDITOR_PERF_BUDGETS.sheets.progressiveLoadRows).toBe(5_000);
    expect(EDITOR_PERF_BUDGETS.slides.progressiveLoadSlides).toBe(80);
  });

  it("fails when open time exceeds hard budget", () => {
    const result = evaluateEditorOpenBudget({
      surface: "docs",
      openInteractiveMs: EDITOR_PERF_BUDGETS.docs.openInteractiveHardMs + 1,
    });
    expect(result.verdict).toBe("fail");
    expect(result.reasons.some((reason) => /hard budget/i.test(reason))).toBe(true);
  });

  it("warns on soft budget and requires progressive load for large docs", () => {
    const soft = evaluateEditorOpenBudget({
      surface: "docs",
      openInteractiveMs: EDITOR_PERF_BUDGETS.docs.openInteractiveMs + 10,
      documentChars: EDITOR_PERF_BUDGETS.docs.progressiveLoadChars + 1,
    });
    expect(soft.verdict).toBe("warn");
    expect(
      requiresProgressiveLoad({
        surface: "docs",
        documentChars: EDITOR_PERF_BUDGETS.docs.progressiveLoadChars + 1,
      }),
    ).toBe(true);
    expect(
      requiresProgressiveLoad({
        surface: "sheets",
        rowCount: EDITOR_PERF_BUDGETS.sheets.progressiveLoadRows + 1,
      }),
    ).toBe(true);
  });

  it("passes under budget without progressive flags", () => {
    const result = evaluateEditorOpenBudget({
      surface: "slides",
      openInteractiveMs: 100,
      slideCount: 10,
    });
    expect(result.verdict).toBe("ok");
    expect(result.reasons).toEqual([]);
  });
});
