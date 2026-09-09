# Mail bounce, complaint, or sender-compromise incident

Owner: Mail and security on-call.

## Detection

- Confirm hard-bounce, complaint, and suppression-growth alerts.
- Compare event rates by bounded provider/event aliases and identify the first
  affected time window.
- Treat unexplained volume, new sending patterns, or credential alerts as a
  possible sender compromise.

## Containment

- Suspend affected sender aliases, bulk campaigns, automations, and unapproved
  API credentials.
- Continue applying suppression decisions; never override a complaint or hard
  bounce to improve throughput.
- Notify the provider through the approved security channel when compromise is
  plausible.

## Diagnosis

- Correlate opaque send IDs with audit events, approval records, automation
  policy, provider responses, and recent credential/config changes.
- Separate list-quality, provider-policy, destination-domain, and unauthorized
  send patterns.
- Do not export recipient addresses or message content into the incident
  workspace.

## Recovery

- Revoke and rotate compromised credentials using the rotation runbook.
- Correct authorization, automation, or audience controls and remediate the
  provider account.
- Re-enable the smallest controlled sender cohort only after security and Mail
  owners approve.

## Verification

- Confirm complaint/bounce rates and suppression growth return to baseline.
- Verify suppressed destinations remain blocked and new sends require the
  intended approval/policy.
- Review audit coverage for disable, rotation, policy change, and re-enable.

## Rollback

- Disable the sender cohort immediately if rates rise or unauthorized activity
  returns.
- Restore the last known-good policy/configuration while keeping rotated
  credentials revoked.

## Post-incident evidence

- Preserve provider case IDs, aggregate event graphs, opaque send IDs, audit
  rows, credential rotation proof, approvals, and re-enable criteria.
- Record regulatory or customer-notification decisions without including
  recipient data.
