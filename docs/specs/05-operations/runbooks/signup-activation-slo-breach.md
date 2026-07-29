# Signup activation SLO breach

Owner: signup and platform on-call.

## Detection

- Confirm activation p95, miss-rate, or missing-sample alerts.
- Record the bounded tier, plan alias, region, resource ID, and trace query.
- Compare submissions with activation completions and identify the affected
  stage.

## Containment

- Freeze signup deployments and high-risk configuration changes.
- Stop new paid traffic or clearly disable signup when activation cannot
  complete safely.
- Preserve submitted state and prevent duplicate provisioning or charges.

## Diagnosis

- Correlate traces across form submission, billing, tenant provisioning,
  identity setup, and activation with opaque IDs.
- Check dependency health, queue age, worker failures, recent releases, and
  provider events.
- Keep applicant data, payment details, and credentials out of incident
  evidence.

## Recovery

- Restore the failed dependency or revert the failing release/configuration.
- Resume provisioning in bounded, idempotent batches and reconcile ambiguous
  billing/provisioning outcomes.
- Reopen signup gradually after activation latency stabilizes.

## Verification

- Confirm activation p95, miss rate, and sample production remain healthy for
  30 minutes.
- Complete a controlled signup for each supported tier and verify billing,
  identity, provisioning, audit, and welcome state exactly once.

## Rollback

- Close signup and stop workers if duplicate, incomplete, or unauthorized
  provisioning returns.
- Revert to the last known-good version while retaining submitted records for
  reconciliation.

## Post-incident evidence

- Preserve alert graphs, bounded operational dimensions, opaque trace/resource
  IDs, provider/deployment events, reconciliation totals, and synthetic proof.
- Record impact and follow-ups without applicant or payment data.
