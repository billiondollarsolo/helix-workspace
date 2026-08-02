/**
 * ED.10 — large-document performance budgets for native Docs/Sheets/Slides.
 * Pure policy used by editors shells and CI gates; not reimplemented in tests.
 */

export type EditorSurface = "docs" | "sheets" | "slides";

export interface EditorPerfBudget {
  readonly surface: EditorSurface;
  /** Soft warning threshold (ms) for cold open → first interactive paint. */
  readonly openInteractiveMs: number;
  /** Hard fail threshold (ms). */
  readonly openInteractiveHardMs: number;
  /** Max characters before progressive load / virtualization is required. */
  readonly progressiveLoadChars: number;
  /** Max rows (sheets) before virtualization is required. */
  readonly progressiveLoadRows: number;
  /** Max slides before progressive slide load is required. */
  readonly progressiveLoadSlides: number;
}

export const EDITOR_PERF_BUDGETS: Readonly<Record<EditorSurface, EditorPerfBudget>> = {
  docs: {
    surface: "docs",
    openInteractiveMs: 2_500,
    openInteractiveHardMs: 5_000,
    progressiveLoadChars: 250_000,
    progressiveLoadRows: Number.POSITIVE_INFINITY,
    progressiveLoadSlides: Number.POSITIVE_INFINITY,
  },
  sheets: {
    surface: "sheets",
    openInteractiveMs: 3_000,
    openInteractiveHardMs: 6_000,
    progressiveLoadChars: Number.POSITIVE_INFINITY,
    progressiveLoadRows: 5_000,
    progressiveLoadSlides: Number.POSITIVE_INFINITY,
  },
  slides: {
    surface: "slides",
    openInteractiveMs: 2_800,
    openInteractiveHardMs: 5_500,
    progressiveLoadChars: Number.POSITIVE_INFINITY,
    progressiveLoadRows: Number.POSITIVE_INFINITY,
    progressiveLoadSlides: 80,
  },
};

export type EditorPerfVerdict = "ok" | "warn" | "fail";

export interface EditorOpenMeasurement {
  readonly surface: EditorSurface;
  readonly openInteractiveMs: number;
  readonly documentChars?: number;
  readonly rowCount?: number;
  readonly slideCount?: number;
}

export function evaluateEditorOpenBudget(measurement: EditorOpenMeasurement): {
  readonly verdict: EditorPerfVerdict;
  readonly budget: EditorPerfBudget;
  readonly reasons: readonly string[];
} {
  const budget = EDITOR_PERF_BUDGETS[measurement.surface];
  const reasons: string[] = [];
  let verdict: EditorPerfVerdict = "ok";

  if (measurement.openInteractiveMs > budget.openInteractiveHardMs) {
    verdict = "fail";
    reasons.push(
      `openInteractiveMs ${String(measurement.openInteractiveMs)} exceeds hard budget ${String(budget.openInteractiveHardMs)}`,
    );
  } else if (measurement.openInteractiveMs > budget.openInteractiveMs) {
    verdict = "warn";
    reasons.push(
      `openInteractiveMs ${String(measurement.openInteractiveMs)} exceeds soft budget ${String(budget.openInteractiveMs)}`,
    );
  }

  if (
    measurement.documentChars !== undefined &&
    measurement.documentChars > budget.progressiveLoadChars
  ) {
    reasons.push(
      `documentChars ${String(measurement.documentChars)} requires progressive load (>${String(budget.progressiveLoadChars)})`,
    );
  }
  if (measurement.rowCount !== undefined && measurement.rowCount > budget.progressiveLoadRows) {
    reasons.push(
      `rowCount ${String(measurement.rowCount)} requires sheet virtualization (>${String(budget.progressiveLoadRows)})`,
    );
  }
  if (
    measurement.slideCount !== undefined &&
    measurement.slideCount > budget.progressiveLoadSlides
  ) {
    reasons.push(
      `slideCount ${String(measurement.slideCount)} requires progressive slides (>${String(budget.progressiveLoadSlides)})`,
    );
  }

  return { verdict, budget, reasons };
}

/** True when document size requires progressive strategies under ED.10 budgets. */
export function requiresProgressiveLoad(
  measurement: Omit<EditorOpenMeasurement, "openInteractiveMs">,
): boolean {
  const budget = EDITOR_PERF_BUDGETS[measurement.surface];
  if (
    measurement.documentChars !== undefined &&
    measurement.documentChars > budget.progressiveLoadChars
  ) {
    return true;
  }
  if (measurement.rowCount !== undefined && measurement.rowCount > budget.progressiveLoadRows) {
    return true;
  }
  if (
    measurement.slideCount !== undefined &&
    measurement.slideCount > budget.progressiveLoadSlides
  ) {
    return true;
  }
  return false;
}
