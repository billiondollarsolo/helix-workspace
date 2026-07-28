# V2 negative-security matrix

The authoritative, machine-checked requirement index is
`infra/scripts/negative-security-matrix.mjs`. It mirrors every row and every semicolon/comma
separated negative case in Task V2 of the production-readiness plan and maps each case to one or
more concrete Vitest selectors.

Validate the index and print the runnable command set:

```sh
node infra/scripts/negative-security-matrix.mjs
pnpm exec vitest run infra/scripts/negative-security-matrix.test.mjs
```

The emitted `status: "mapped"` is deliberately not a test-pass claim. It proves only that the plan
rows still match and that every referenced test file and selector exists. Release evidence must
also contain successful output from the emitted commands.

The Tenant adversarial fixture uses real PostgreSQL and is intentionally marked `live-postgres`.
Run that command with migrations applied and `DATABASE_URL` set; a skipped local run does not
satisfy V2. The remaining references run in the default test environment.

This matrix covers the storage-only Workspace MVP: Mail, Drive file storage, secure Chat, shared
authentication/audit/webhook boundaries, and agent/AI policy. It does not add or validate native
document, spreadsheet, or presentation editing.
