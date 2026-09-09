# Workspace observability

The `Helix Workspace Operations` Grafana dashboard and
`helix-workspace-operations.yml` Prometheus rules are the production operations
contract for the Workspace pilot. They cover HTTP, authorization, dependencies,
workers, Mail, Drive, Chat, agents, audit integrity, backups, and restore
drills.

## Data-safety contract

Operational telemetry is content-free. Instrumentation and exporters must not
put email addresses, recipients, subjects, message bodies, filenames, object
keys, prompt text, access or refresh tokens, credential identifiers, tenant
names, organization slugs, or user-supplied free text in metric names, labels,
alert annotations, or dashboard variables.

Allowed metric dimensions are bounded operational enums or infrastructure
identifiers:

| Area                     | Allowed dimensions                                        |
| ------------------------ | --------------------------------------------------------- |
| HTTP and auth            | route template, method, status code/class, decision       |
| Dependencies and workers | allow-listed dependency or worker name, outcome           |
| Mail                     | direction, provider alias, event type, outcome            |
| Drive and scanning       | scanner alias, scan state, upload outcome                 |
| Chat                     | route template, outcome                                   |
| Agents                   | feature, provider/model alias, tool ID, decision, outcome |
| Audit and recovery       | destination alias, job name, outcome                      |

Do not use raw paths where they may contain resource identifiers; record the
route template instead. Traces and logs may carry approved opaque trace or
resource IDs, but must follow the same content and secret redaction rules.

## Metric contract

The dashboard and alert rules consume these metric families:

- `helix_http_*`, `helix_permission_checks_total`, and
  `helix_auth_rate_limit_decisions_total`
- `helix_dependency_up`, `helix_outbox_*`, and `helix_worker_failures_total`
- `helix_mail_*`
- `helix_drive_uploads_total` and `helix_security_*`
- `helix_websocket_connections_active` and `helix_chat_*`
- `helix_llm_*`, `helix_tool_invocations_total`,
  `helix_agent_pending_approvals`, and `helix_agent_*`
- `helix_audit_*`, `helix_backup_*`,
  `helix_restore_drill_last_success_timestamp_seconds`, and
  `helix_certificate_expiry_timestamp_seconds`

Deployments must configure the application and infrastructure exporters that
produce this contract before declaring O5 operational. Missing critical
dependency, scanner, backup, restore, socket, and audit-verification telemetry
is itself alertable; silence is not treated as health.

## Operator entry points

- Grafana dashboard: `Helix Workspace Operations`
- Prometheus rules:
  `infra/observability/prometheus/rules/helix-workspace-operations.yml`
- Incident index: [Helix Runbook](RUNBOOK.md#workspace-incident-runbooks)
- Focused procedures: [`docs/runbooks/`](runbooks/)

Start the local stack with:

```sh
docker compose --profile observability up -d
```

Before a production launch, verify that every alert reaches the intended paging
route and that its `runbook_url`, `resource_id`, and `trace_query` annotations
render correctly. Capture screenshots or exported alert events without message
content, secrets, or personal data.
