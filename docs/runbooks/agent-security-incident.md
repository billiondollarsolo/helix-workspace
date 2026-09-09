# Agent credential or prompt-injection incident

Owner: security and agents on-call. Treat confirmed credential use or
unauthorized external effects as P1.

## Detection

- Confirm agent-call failures, approval backlog, denial, rate-limit, cost, or
  operational-control alerts.
- Record the feature/tool alias, opaque actor/resource IDs, trace IDs, and first
  suspicious time.
- Identify unexpected tools, destinations, approvals, cost, or untrusted-input
  policy denials without copying prompt text.

## Containment

- Enable the scoped agent kill switch or deny the affected tool/provider.
- Revoke suspected credentials and pending actions; preserve audit and approval
  records.
- Block unattended writes while retaining explicit human confirmation for any
  essential recovery action.

## Diagnosis

- Correlate tool invocations, policy decisions, approvals, credential version,
  model/provider alias, and outbound effects with opaque IDs.
- Determine whether the cause is credential theft, prompt injection, excessive
  authority, approval abuse, or a model/provider fault.
- Do not place prompts, tokens, message bodies, or secret values in telemetry
  or incident records.

## Recovery

- Rotate credentials and invalidate old sessions/grants.
- Correct tool scope, policy, prompt-boundary, rate/cost, or approval controls.
- Re-enable one low-risk read path first, then bounded writes after security
  approval.

## Verification

- Confirm suspicious calls stop and denial/failure/cost rates return to
  baseline.
- Exercise trusted and adversarial test inputs; verify high-risk untrusted
  actions are denied and writes require the intended approval.
- Reconcile every external effect and confirm complete audit coverage.

## Rollback

- Re-enable the kill switch and revoke the new credential if suspicious
  behavior or control gaps recur.
- Restore the last known-good policy/runtime while keeping compromised
  credentials invalid.

## Post-incident evidence

- Preserve alert history, opaque IDs, audit/policy/approval records, credential
  version transitions, reconciled effects, tests, and operator approvals.
- Store sensitive prompts or secrets only in the restricted forensic system,
  when strictly necessary.
