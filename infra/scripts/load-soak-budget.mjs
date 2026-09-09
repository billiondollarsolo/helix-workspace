/**
 * V3 — load/soak budget contract (structural + measurement evaluator).
 * Does not invent live RPS results; evaluates provided measurements against budgets.
 */
export const LOAD_SOAK_BUDGETS = {
  apiP95Ms: 500,
  apiP99Ms: 1_500,
  errorRateMax: 0.01,
  soakDurationMinMinutes: 30,
  minSuccessfulRequests: 1_000,
};

/**
 * Each measurement field is either capped ("max") or floored ("min") by one budget.
 * A field that is absent (or not a number) is unmeasured, not a violation.
 */
const LOAD_SOAK_CHECKS = [
  { field: "apiP95Ms", budgetKey: "apiP95Ms", bound: "max" },
  { field: "apiP99Ms", budgetKey: "apiP99Ms", bound: "max" },
  { field: "errorRate", budgetKey: "errorRateMax", bound: "max" },
  { field: "durationMinutes", budgetKey: "soakDurationMinMinutes", bound: "min" },
  { field: "successfulRequests", budgetKey: "minSuccessfulRequests", bound: "min" },
];

export function evaluateLoadSoakMeasurement(m) {
  const reasons = [];
  for (const { field, budgetKey, bound } of LOAD_SOAK_CHECKS) {
    const observed = m[field];
    if (typeof observed !== "number") continue;
    const budget = LOAD_SOAK_BUDGETS[budgetKey];
    if (bound === "max" && observed > budget) {
      reasons.push(`${field} ${observed} > ${budget}`);
    }
    if (bound === "min" && observed < budget) {
      reasons.push(`${field} ${observed} < ${budget}`);
    }
  }
  return { ok: reasons.length === 0, budgets: LOAD_SOAK_BUDGETS, reasons };
}
