/* Administrator requests are refused once the session's verification is no
 * longer recent. A refused request asks the mounted prompt for a fresh 2-step
 * verification and is then sent again, so the person carries on where they
 * were. Concurrent refusals share one prompt. With no prompt mounted, or when
 * the person cancels, the caller gets `false` and handles the refusal. */

/** `verification`: the action needs a second step the session has not shown.
 *  `reauthentication`: the whole session must be verified again; signing in
 *  again is the fallback when the person has no second step to offer. */
export type StepUpReason = "verification" | "reauthentication";

const VERIFICATION_CODES = new Set([
  "admin_mfa_required",
  "crown_jewel_step_up_required",
  "step_up_required",
]);
/** After a cancel, background reads stop asking for a while; actions still ask. */
const QUIET_AFTER_CANCEL_MS = 120_000;

interface PendingStepUp {
  readonly reason: StepUpReason;
  readonly promise: Promise<boolean>;
  readonly settle: (verified: boolean) => void;
}

let pending: PendingStepUp | null = null;
let quietUntil = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Why the server refused the request, when a fresh verification resolves it. */
export async function stepUpRefusal(response: Response): Promise<StepUpReason | null> {
  if (response.status !== 401 && response.status !== 403) return null;
  const output: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (typeof output !== "object" || output === null) return null;
  const body = output as { readonly code?: unknown; readonly error?: unknown };
  const code =
    typeof body.error === "object" && body.error !== null
      ? (body.error as { readonly code?: unknown }).code
      : body.code;
  if (response.status === 401) {
    return code === "session_reauthentication_required" ? "reauthentication" : null;
  }
  return typeof code === "string" && VERIFICATION_CODES.has(code) ? "verification" : null;
}

/**
 * Resolves true once the person has verified, false when they cancel or no
 * prompt is mounted. `userInitiated` is false for background reads, which do
 * not reopen a prompt the person has just dismissed.
 */
export function requestSecondFactorStepUp(
  reason: StepUpReason,
  userInitiated = true,
): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(false);
  if (pending === null) {
    if (!userInitiated && reason === "verification" && Date.now() < quietUntil) {
      return Promise.resolve(false);
    }
    let settle: (verified: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    pending = { reason, promise, settle };
    notify();
  }
  return pending.promise;
}

export function settleSecondFactorStepUp(verified: boolean): void {
  const current = pending;
  if (current === null) return;
  pending = null;
  quietUntil = verified ? 0 : Date.now() + QUIET_AFTER_CANCEL_MS;
  current.settle(verified);
  notify();
}

/** The reason for the open prompt, or null while nothing is waiting. */
export function secondFactorStepUpReason(): StepUpReason | null {
  return pending?.reason ?? null;
}

export function subscribeSecondFactorStepUp(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // Nobody is left to answer, so waiting requests get their refusal back.
    if (listeners.size === 0) {
      settleSecondFactorStepUp(false);
      quietUntil = 0;
    }
  };
}
