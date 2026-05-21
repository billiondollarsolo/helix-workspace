# Helix Helm Chart

This chart deploys Helix against external production services. It does not install default Postgres, Vault, object storage, KMS, or SIEM backends unless their optional toggles are enabled.

## Tier Profiles

- `values.yaml`: TASK-A00 / personal baseline with portable defaults.
- `values-business.yaml`: TASK-A00 / Tier 2 business profile with Caddy mTLS expectations and recommended allow-list egress.
- `values-enterprise.yaml`: TASK-A02 / enterprise profile with SPIRE, Vault, KMS, SIEM, CloudNativePG HA Postgres, daily base backups, and PITR/WAL archiving to object storage.
- `values-sovereign.yaml`: TASK-A03 / Tier 4 sovereign profile with SPIRE, Vault CSI, KMS, SIEM, digest-pinned FIPS image selection, STIG image policy, FIPS node targeting, and default-deny egress.

Render examples:

```sh
helm template helix infra/helm/helix
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml
helm template helix infra/helm/helix -f infra/helm/helix/values-enterprise.yaml
helm template helix infra/helm/helix -f infra/helm/helix/values-sovereign.yaml
```

Run the PRD hardening contract validation for every tier overlay:

```sh
pnpm infra:helm:validate
```

The script runs `helm lint` and `helm template` for the base, business, enterprise, and sovereign
profiles, then verifies the rendered HPA, PDB, NetworkPolicy, CloudNativePG, Vault, SIEM,
FIPS/STIG, and air-gap contracts. If `kubeconform` is installed it also validates rendered
manifests against Kubernetes schemas.

## WebSocket Autoscaling (PRD 16.1)

The HorizontalPodAutoscaler scales on **CPU + memory + active WebSocket
connections**. The WebSocket signal covers Yjs document sync and chat realtime
sessions, which CPU alone does not track well (idle-but-connected sockets pin
memory and event-loop fan-out without burning CPU).

The app publishes a Prometheus gauge `helix_websocket_connections_active` on
`/metrics` (port 3000). The HPA reads it through a custom/external metrics
adapter — it is **not** a built-in Kubernetes resource metric, so an adapter is
required:

- `metricType: Pods` (default): install
  [prometheus-adapter](https://github.com/kubernetes-sigs/prometheus-adapter)
  with a rule that maps `helix_websocket_connections_active` to a Pods metric.
  The HPA then targets `targetAverageValue` connections per pod.
- `metricType: External`: install [KEDA](https://keda.sh/) or the Prometheus
  external-metrics adapter and target the cluster-wide `targetValue`.

Relevant `values.yaml` keys:

```yaml
autoscaling:
  websocketConnections:
    enabled: true
    metricType: Pods            # or External
    metricName: helix_websocket_connections_active
    targetAverageValue: "150"   # Pods mode
    targetValue: "1200"         # External mode
  behavior:                     # spiky WS traffic: scale out fast, in slow
    scaleUp: { stabilizationWindowSeconds: 30 }
    scaleDown: { stabilizationWindowSeconds: 300 }
```

The Deployment also carries `prometheus.io/scrape`, `prometheus.io/path`, and
`prometheus.io/port` annotations so the adapter can discover the endpoint. Set
`autoscaling.websocketConnections.enabled=false` to fall back to CPU/memory-only
autoscaling.

## Role-based Deployments (core-app scaling)

Core apps (mail, chat, drive, docs, calendar, meet, assistant) are toggleable
platform modules that ship in **one image**. By default the chart renders a
single all-in-one Deployment running the default role (all enabled apps).

To scale WebSocket-heavy apps independently, add extra Deployments of the
**same image** parameterized by role via `roleDeployments`:

```yaml
roleDeployments:
  - name: realtime          # Deployment suffix: <release>-helix-realtime
    role: realtime          # named role -> sets HELIX_ROLE (runs chat + meet)
    replicaCount: 3
    autoscaling:
      enabled: true
      minReplicas: 3
      maxReplicas: 8
    nodeSelector: { workload: realtime }
  - name: mailer
    apps: "mail"            # explicit subset -> sets HELIX_APPS (overrides role)
```

Each entry renders an additional `Deployment` (and an `HPA` when
`autoscaling.enabled`) reusing the same image, configmap, and external secrets;
only `HELIX_ROLE` / `HELIX_APPS` differ. The server boots only that role's
modules. Leaving `roleDeployments` empty (the default) keeps the single
all-in-one Deployment. `docker-compose` always runs one all-in-one service.

## Publishing the Chart (Release Pipeline)

The chart is published by `.github/workflows/helm-release.yml`, which runs on
`helm-v<version>` tags (or manual dispatch). The pipeline lints, templates every
tier overlay, runs `infra/scripts/validate-helm.sh`, then publishes the chart to
**two** destinations:

1. **OCI registry** — `oci://ghcr.io/<owner>/charts/helix`:

   ```sh
   helm install helix oci://ghcr.io/<owner>/charts/helix --version 0.9.0
   ```

2. **Classic Helm repo** on GitHub Pages with a merged `index.yaml`:

   ```sh
   helm repo add helix https://<owner>.github.io/<repo>/charts
   helm repo update
   helm install helix helix/helix --version 0.9.0
   ```

To cut a release, bump `version`/`appVersion` in `Chart.yaml` and push a tag:

```sh
git tag helm-v0.9.0 && git push origin helm-v0.9.0
```

## Required External Secrets

For production, set `external.postgres.url`, `external.redis.url`, and `external.nats.url` to empty strings and point the matching `urlSecret` entries at operator-managed secrets. Object storage, Meilisearch, KMS, and SIEM tokens are always read from Kubernetes Secrets.

NetworkPolicy egress is CIDR based because upstream Kubernetes NetworkPolicy does not support DNS names. Add private endpoint CIDRs for Postgres, Vault, S3, KMS, SIEM, NATS, Redis, and Meilisearch before enabling stricter tier overlays. The sovereign overlay renders `egress: []` by default; add approved private CIDRs only after the air-gap network review.

## Tier 4 FIPS/STIG Values

The sovereign overlay sets `fips.enabled=true`, `fips.crypto.mode=required`, and `stig.imagePolicy.requireDigest=true`. Replace the placeholder zero `fips.imageDigest` with the promoted internal-registry digest before production use. The rendered Deployment will use the FIPS image repository by digest and expose the crypto adapter contract through `HELIX_FIPS_MODE`, `HELIX_CRYPTO_ADAPTER`, `HELIX_TLS_MIN_VERSION`, and `HELIX_TLS_ALLOWED_CIPHERS`.

The matching policy and evidence contracts live under `infra/security/tier4/`.

## CloudNativePG

Set `cloudnativepg.enabled=true` to render a `postgresql.cnpg.io/v1` `Cluster`. The enterprise overlay enables this by default and points `DATABASE_URL` at the CloudNativePG-generated `helix-postgres-app` Secret key `uri`.

The chart exposes:

- `cloudnativepg.backup.barmanObjectStore`: object-store destination, endpoint, S3 credentials, WAL compression/encryption/parallelism, base-backup compression/encryption, tags, and extra Barman command arguments.
- `cloudnativepg.scheduledBackup`: daily `ScheduledBackup` settings using CloudNativePG's six-field cron format.
- `cloudnativepg.bootstrap.recovery` and `cloudnativepg.recovery.externalClusters`: PITR/recovery source and `recoveryTarget` settings for restore clusters.
- `cloudnativepg.tde`: an explicit TDE/KMS surface rendered as Cluster annotations, inherited resource annotations, PVC template annotations, and optional PostgreSQL parameters for environments using storage-class encryption, Postgres TDE images, or pgcrypto-based compensating controls.

For Tier 3, replace the example backup destination, object-store credentials Secret, storage-class/KMS annotations, and `--sse-kms-key-id` values with your cloud or on-prem KMS values before install.
