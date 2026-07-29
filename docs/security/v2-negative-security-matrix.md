# V2 negative-security matrix

The authoritative, machine-checked requirement index is
`infra/scripts/negative-security-matrix.mjs`. It mirrors every row and every semicolon/comma
separated negative case in Task V2 of the production-readiness plan and maps each case to one or
more concrete Vitest selectors.

Validate the index and print the runnable command set:

```sh
pnpm quality:negative-security-matrix
pnpm quality:production-readiness-contract:test
```

The emitted `status: "mapped"` is deliberately not a test-pass claim. It proves only that the plan
rows still match and that every referenced test file and selector exists. The named contract suite
is mandatory in CI and fails when a plan row, test selector, command mapping, production Compose
contract, image workflow, supply-chain workflow, or dependency-audit contract drifts.

The ordinary root test jobs execute the app-owned default-environment selectors as part of both
supported platform modes. The named production-readiness and release-evidence suites execute the
root infrastructure selectors. That CI output is contract evidence, not live integration evidence.

The Tenant adversarial fixture uses real PostgreSQL and is intentionally marked `live-postgres`.
The `backend-live-demo-data` CI job runs it after both migration sets have applied to the disposable
database. A skipped local run does not satisfy V2. The remaining references run in the default
test environment.

This matrix covers the storage-only Workspace MVP: Mail, Drive file storage, secure Chat, shared
authentication/audit/webhook boundaries, and agent/AI policy. It does not add or validate native
document, spreadsheet, or presentation editing.
