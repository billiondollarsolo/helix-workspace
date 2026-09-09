# Production observability security and recovery

Use the files ending in `production` under `infra/observability` only in a production deployment.
The Compose profile remains an intentionally local, loopback-only developer stack.

## Deployment contract

- Deploy Loki, Tempo, and the OTEL collector with at least three replicas, a disruption budget of one,
  zone spreading, and persistent WAL/queue volumes. Apply
  `infra/observability/production/network-policies.yml` after replacing the documented namespace and
  identity selectors with the cluster's exact selectors. Do not add a public Service for a backend.
- Set `OTEL_QUEUE_DIRECTORY` to the collector's persistent queue mount (for example,
  `/var/lib/otel/queue`).
- Start Loki and Tempo with `-config.expand-env=true` and the collector with its production config.
  `POD_IP` must be the pod IP, so listeners do not bind every interface.
- Issue separate, 30-day-or-shorter client certificates to Helix emitters, the collector, and Grafana.
  The server/client CA mounts in the production files are mandatory. A certificate for one workload
  must not be reusable by another workload class.
- Enforce strict service-mesh mTLS for Loki/Tempo internal gRPC and Tempo-to-Kafka traffic. Tempo 3.0's
  Kafka client also uses the `TEMPO_KAFKA_USERNAME` and `TEMPO_KAFKA_PASSWORD` secret values. Run at
  least three brokers/partitions with replication factor 3 and minimum in-sync replicas 2.
- Set one opaque `HELIX_OBSERVABILITY_TENANT_ID` per deployment. The collector and provisioned Grafana
  data sources set `X-Scope-OrgID`; clients cannot select it. Loki and Tempo reject missing tenant
  headers. Direct access is restricted to the collector or Grafana by NetworkPolicy and mTLS.
- Mount the Helix OTLP CA, certificate, and key read-only and set
  `OTEL_EXPORTER_OTLP_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`, and
  `OTEL_EXPORTER_OTLP_CLIENT_KEY`. Production boot fails when telemetry is enabled with HTTP or without
  those files.
- Keep Grafana behind the identity-aware ingress. Anonymous access and self-sign-up remain disabled.
  The ingress must emit immutable access records containing authenticated principal, request ID,
  method, route, status, and the verified client-certificate subject. Ship Grafana router logs plus
  Loki/Tempo request logs to the security audit sink. Never log headers named in the production
  exclusion lists or data-source query/request bodies.

The authoritative machine-readable requirements are in
`infra/observability/production/deployment-contract.yml`. Treat a deployment that does not meet every
field as non-production.

## Detection

Investigate when a backend replica or zone is unavailable, WAL replay grows, object-store writes fail,
the collector drops/retries batches, a tenant hits an ingestion/query limit, TLS handshakes fail above
the expected probe baseline, audit delivery stops, or the most recent restore drill is older than 90
days. Record the alert, deployment tenant, trace/request ID, affected time window, certificate serials,
and object-store replication status; do not copy log or trace bodies into the incident ticket.

## Containment and diagnosis

1. Revoke a suspected workload certificate and rotate its issuing intermediate. Keep the default-deny
   policy applied; do not expose a backend for debugging.
2. Compare the running config checksum with Git, then inspect collector drop/retry counts, ring health,
   WAL age, compactor status, and S3 errors.
3. Verify both telemetry buckets without printing credentials:

   ```sh
   aws s3api get-bucket-versioning --bucket "$LOKI_S3_BUCKET" --query Status --output text
   aws s3api get-bucket-replication --bucket "$LOKI_S3_BUCKET" --query ReplicationConfiguration.Role --output text
   aws s3api get-bucket-versioning --bucket "$TEMPO_S3_BUCKET" --query Status --output text
   aws s3api get-bucket-replication --bucket "$TEMPO_S3_BUCKET" --query ReplicationConfiguration.Role --output text
   ```

   Every result must be non-empty and versioning must be `Enabled`. Confirm the replica destination is
   in a separate failure domain and retains versions for at least 35 days (30-day incident window plus
   recovery margin).

4. Query the immutable access sink by request ID. Distinguish a rejected unauthenticated attempt from a
   trusted Grafana/collector request before changing certificates or limits.

## Unauthorized access drill

Run this from a disposable pod outside every allowed selector. Substitute the internal endpoint; do
not supply a client certificate:

```sh
curl --fail-with-body --cacert /drill/backend-ca.crt https://loki.helix-observability.svc.cluster.local:3100/ready
curl --fail-with-body --cacert /drill/backend-ca.crt https://tempo.helix-observability.svc.cluster.local:3200/ready
curl --fail-with-body --cacert /drill/collector-ca.crt https://otel-collector.helix-observability.svc.cluster.local:4318/v1/traces
```

The NetworkPolicy should time out before TLS. From a network-allowed pod with no certificate or a
certificate from the wrong workload CA, all three commands must fail the TLS handshake and must not
produce an accepted backend request. Repeat the Loki/Tempo query through authenticated Grafana and
confirm success plus an immutable audit event. A caller-supplied `X-Scope-OrgID` sent to the collector
must not change the fixed header used by its backend exporters.

## Node-loss and retention drill

1. Write uniquely identified canary log and trace records through the authenticated collector and wait
   until both are queryable through Grafana. Record their timestamps and IDs.
2. Delete one Loki pod, one Tempo pod, and one collector pod, one at a time. Confirm the disruption
   budget keeps quorum and replacements replay their persistent WAL/queue.
3. Query both canaries after every deletion and after object-store compaction. The full canary time
   window must remain available. If it does not, freeze rollouts and restore from the replicated bucket.
4. Confirm data older than 720 hours is expired while the canary inside the 720-hour incident window is
   retained. Do not raise the configured stream, label, trace-size, or query caps without a measured
   capacity review.

## Backup and restore

Configuration recovery uses the reviewed Git revision: render the exact production ConfigMaps and
NetworkPolicies from that revision, validate them, and roll out one replica at a time. Certificates and
object-store credentials come from the secret manager and are never placed in Git or a backup archive.

Telemetry data recovery uses versioned, replicated object storage; local WAL is recovery acceleration,
not the backup. Restore into new empty buckets at a provider recovery point preceding the incident.
Keep the source buckets read-only, change `LOKI_S3_BUCKET` and `TEMPO_S3_BUCKET` to the recovered
buckets, start isolated backend replicas, and query sampled canary IDs across the incident window.
Promote the recovered endpoints only after hash/version inventory and tenant-isolation checks pass.

Rollback by restoring the previous ConfigMaps and bucket environment values, then restart one replica
at a time. Preserve the failed recovery buckets and all access records for the incident review. Record
RPO, RTO, sampled object versions, config Git SHA, pod/zone loss results, rejected-access evidence, and
the operator approving promotion.
