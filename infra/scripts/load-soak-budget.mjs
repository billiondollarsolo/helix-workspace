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

export function evaluateLoadSoakMeasurement(m) {
  const reasons = [];
  let ok = true;
  if (typeof m.apiP95Ms === "number" && m.apiP95Ms > LOAD_SOAK_BUDGETS.apiP95Ms) {
    ok = false;
    reasons.push(`apiP95Ms ${m.apiP95Ms} > ${LOAD_SOAK_BUDGETS.apiP95Ms}`);
  }
  if (typeof m.apiP99Ms === "number" && m.apiP99Ms > LOAD_SOAK_BUDGETS.apiP99Ms) {
    ok = false;
    reasons.push(`apiP99Ms ${m.apiP99Ms} > ${LOAD_SOAK_BUDGETS.apiP99Ms}`);
  }
  if (typeof m.errorRate === "number" && m.errorRate > LOAD_SOAK_BUDGETS.errorRateMax) {
    ok = false;
    reasons.push(`errorRate ${m.errorRate} > ${LOAD_SOAK_BUDGETS.errorRateMax}`);
  }
  if (
    typeof m.durationMinutes === "number" &&
    m.durationMinutes < LOAD_SOAK_BUDGETS.soakDurationMinMinutes
  ) {
    ok = false;
    reasons.push(
      `durationMinutes ${m.durationMinutes} < ${LOAD_SOAK_BUDGETS.soakDurationMinMinutes}`,
    );
  }
  if (
    typeof m.successfulRequests === "number" &&
    m.successfulRequests < LOAD_SOAK_BUDGETS.minSuccessfulRequests
  ) {
    ok = false;
    reasons.push(
      `successfulRequests ${m.successfulRequests} < ${LOAD_SOAK_BUDGETS.minSuccessfulRequests}`,
    );
  }
  return { ok, budgets: LOAD_SOAK_BUDGETS, reasons };
}
