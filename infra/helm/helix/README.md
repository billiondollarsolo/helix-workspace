# Helix Helm Chart

This chart deploys Helix against external production services. It does not install default Postgres, Vault, object storage, KMS, or SIEM backends unless their optional toggles are enabled.

## Tier Profiles

- `values.yaml`: TASK-A00 / personal baseline with portable defaults.
- `values-business.yaml`: TASK-A00 / Tier 2 business profile with Caddy mTLS expectations and default-deny workload networking.
- `values-enterprise.yaml`: TASK-A02 / enterprise profile with SPIRE, Vault, KMS, SIEM, CloudNativePG HA Postgres, daily base backups, and PITR/WAL archiving to object storage.
- `values-sovereign.yaml`: TASK-A03 / Tier 4 sovereign profile with SPIRE, Vault CSI, KMS, SIEM, digest-pinned FIPS image selection, STIG image policy, FIPS node targeting, and default-deny egress.

## Workspace packaging (MVP fail-closed)

Defaults match production Compose and `AGENTS.md`:

| Value                                                    | Default                     |
| -------------------------------------------------------- | --------------------------- |
| `workspace.profile`                                      | `mvp`                       |
| `workspace.apps`                                         | `mail,drive,chat,assistant` |
| `workspace.editorsMigrationsEnabled`                     | `false`                     |
| `workspace.modules.{docs,calendar,meet,editors}.enabled` | `false`                     |

These render into `HELIX_WORKSPACE_PROFILE`, `HELIX_APPS`,
and `HELIX_CONFIG_JSON.modules`. Expanding
`workspace.apps` without `workspace.profile=full` fails chart render (PKG flip
guard). Full Workspace enablement is **not** a chart default — see
`docs/architecture/ha-rpo-rto.md` and `docs/architecture/compose-helm-parity.md`.

RPO ≤ 24h / RTO ≤ 4h drills use the same backup/restore scripts as Compose
against external Postgres, or CloudNativePG recovery on the enterprise overlay.

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

The script runs with Helm 4.2.3 and targets Kubernetes 1.34 through 1.36. It executes `helm lint`
and `helm template` for the base, business, enterprise, and sovereign profiles, then verifies the
rendered HPA, PDB, NetworkPolicy, CloudNativePG, Vault, SIEM, FIPS/STIG, air-gap, and opt-in
PrometheusRule contracts. CI also requires kubeconform 0.8.0 and validates rendered manifests
against Kubernetes schemas; local validation reports an explicit skip when kubeconform is absent.

## Optional password manager

The chart can deploy a [Vaultwarden](https://github.com/dani-garcia/vaultwarden) password manager
next to the workspace. It is off by default: with `passwords.enabled=false` nothing is rendered
and the application advertises nothing.

```yaml
passwords:
  enabled: true
  host: vault.example.com # its own hostname, never a path on the workspace's
  signupDomains: example.com # who may create a vault account
  smtp:
    host: smtp.example.com
    from: passwords@example.com
    username: provider-user
    passwordSecretName: helix-passwords-smtp # an existing Secret, key "password"
  ingress:
    className: nginx
    tlsSecretName: vault-example-com-tls
  networkPolicy:
    ingress:
      - namespace: ingress-nginx
        podLabels:
          app.kubernetes.io/name: ingress-nginx
    smtpCidr: 203.0.113.10/32
```

This renders a single-replica Deployment, a Service, an Ingress for `passwords.host`, a
PersistentVolumeClaim, and a NetworkPolicy that allows only the listed ingress sources, DNS, and
the SMTP relay. The claim is annotated `helm.sh/resource-policy: keep`, so uninstalling the
release does not delete people's vaults. The application learns the address through
`HELIX_PASSWORDS_URL`; an administrator then turns it on in **Admin → Apps → Passwords**.

Accounts are separate from workspace accounts and vaults are end-to-end encrypted. Back up the
claim: nothing Helix stores can rebuild a lost vault.

## Signed plugin trust

Enterprise and sovereign pods fail closed unless the operator provides the
`helix-plugin-trust` Secret used by their overlay:

```sh
kubectl create secret generic helix-plugin-trust \
  --from-file=trust.json=/secure/release/plugin-trust.json
```

Make the Secret immutable in production and restrict write access to the
release controller. `trust.json` contains no private signing material. It has
this shape (the Sigstore bundle is the standard JSON bundle emitted when the
release signs the literal `sha256:<hex>` plugin bundle digest):

```json
{
  "catalog": {
    "keyId": "release-2026-09",
    "payload": {
      "version": 1,
      "issuedAt": "2026-09-02T00:00:00Z",
      "expiresAt": "2026-09-09T00:00:00Z",
      "plugins": [
        {
          "id": "com.example.plugin",
          "version": "1.2.3",
          "bundleDigest": "sha256:<64 lowercase hex characters>",
          "publisher": "example-release",
          "sigstoreBundle": {}
        }
      ]
    },
    "signature": "<base64 Ed25519 signature of canonical payload JSON>"
  },
  "trustedCatalogKeys": {
    "release-2026-09": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
  },
  "revokedKeyIds": [],
  "trustedPublishers": {
    "example-release": {
      "issuer": "https://token.actions.githubusercontent.com",
      "uri": "https://github.com/example/plugins/.github/workflows/release.yml@refs/heads/main"
    }
  },
  "revokedPublishers": []
}
```

Use exactly one `email` or `uri` identity for each publisher. Sovereign/offline
verification additionally sets `tufRootPath` and `tufMirrorUrl` on each
publisher to the approved local Sigstore trust root and HTTPS mirror. At boot,
Helix verifies the catalog's Ed25519 signature and lifetime. Before every
plugin import it recomputes the canonical artifact digest, requires an exact
catalog match, then verifies the Fulcio identity, certificate-transparency and
Rekor inclusion proof with Sigstore. Catalog keys and publishers can be denied
immediately through their revocation arrays.

## Antivirus

Production and secure tiers fail readiness unless `external.clamav` points to a healthy clamd whose
loaded signatures are newer than `maxSignatureAgeMs`. Run freshclam beside the daemon and configure
clamd to match Helix's 128 MiB stream/file limit, 1 GiB expanded-scan limit, 10,000-file and
20-level recursion limits, with `AlertExceedsMax` and `AlertEncrypted` enabled. When default-deny
networking is enabled, allow only that clamd endpoint and TCP port in the role's NetworkPolicy
egress. Scanner outages leave uploads unreadable and enter the durable retry/DLQ workflow; an admin
can authorize another real scan for one exact object, but cannot mark bytes clean or bypass clamd.

Rejected bytes are copied only to the private `drive-quarantine/` prefix and a durable database job
removes both that copy and its upload-stage source. Deny public/presigned GET access to this prefix and
configure a short object-store lifecycle expiration as a final orphan-cleanup backstop; the lifecycle
must exceed the longest expected incident/retry window.

## Product SLO Alerts

Enable `monitoring.prometheusRule.enabled` when Prometheus Operator CRDs are installed.
The chart renders product availability, operational health, mail delivery, and search
reconciliation alerts. Their runbooks live in `docs/runbooks/`.

For production paging, use `infra/observability/alertmanager/alertmanager.production.yml`
and mount the external webhook URL as `/etc/alertmanager/secrets/product-slo-paging-webhook-url`.
Public signup is retired and has no alert rules or paging receiver.

## WebSocket Autoscaling (PRD 16.1)

The HorizontalPodAutoscaler scales on **CPU + memory + active WebSocket
connections**. The WebSocket signal covers chat realtime sessions, which CPU alone does not track well (idle-but-connected sockets pin
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
    metricType: Pods # or External
    metricName: helix_websocket_connections_active
    targetAverageValue: "150" # Pods mode
    targetValue: "1200" # External mode
  behavior: # spiky WS traffic: scale out fast, in slow
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
  - name: realtime # Deployment suffix: <release>-helix-realtime
    role: realtime # named role -> sets HELIX_ROLE (runs chat + meet)
    replicaCount: 3
    autoscaling:
      enabled: true
      minReplicas: 3
      maxReplicas: 8
    nodeSelector: { workload: realtime }
    networkPolicy: # optional; otherwise networkPolicy.roleDefault applies
      ingress: []
      egress:
        publicHttps: false
        endpoints: []
        inCluster: []
  - name: mailer
    apps: "mail" # explicit subset -> sets HELIX_APPS (overrides role)
  - name: editors-export
    apps: "editors-export-worker"
  - name: editors-ocr
    apps: "editors-ocr-worker"
```

Each entry renders an additional `Deployment`, an exact-selector `ClusterIP`
`Service`, a dedicated default-deny `NetworkPolicy`, and an `HPA` when
`autoscaling.enabled`. It reuses the same image,
configmap, external secrets, SPIRE identity socket, Vault CSI mount, and pod
annotations; only `HELIX_ROLE` / `HELIX_APPS` differ. The server boots only that
role's modules. Route realtime traffic to `<release>-helix-<name>` inside the
cluster (or make that Service the backend of your ingress). Queue-driven worker
roles use their Service only for health/metrics traffic. Leaving
`roleDeployments` empty (the default) keeps the single all-in-one Deployment.
The primary Service and PDB select only pods labeled `helix.io/role: default`,
so worker-only role pods do not receive main API traffic. `docker-compose`
always runs one all-in-one service.

## Publishing the Chart (Release Pipeline)

The chart is published by `.github/workflows/helm-release.yml`, which runs on
`helm-v<version>` tags (or manual dispatch). The pipeline lints, templates every
tier overlay, runs `infra/scripts/validate-helm.sh`, then publishes the chart to
**two** destinations:

First install the release-signing public key in the target namespace:

```sh
kubectl create secret generic helix-image-signing-key --from-file=cosign.pub=/path/to/cosign.pub
```

Then install from either chart registry:

1. **OCI registry** — `oci://ghcr.io/<owner>/charts/helix`:

   ```sh
   helm install helix oci://ghcr.io/<owner>/charts/helix --version 0.9.0 \
     --set-string image.digest=sha256:<approved-image-digest>
   ```

2. **Classic Helm repo** on GitHub Pages with a merged `index.yaml`:

   ```sh
   helm repo add helix https://<owner>.github.io/<repo>/charts
   helm repo update
   helm install helix helix/helix --version 0.9.0 \
     --set-string image.digest=sha256:<approved-image-digest>
   ```

To cut a release, bump `version`/`appVersion` in `Chart.yaml` and push a tag:

```sh
git tag helm-v0.9.0 && git push origin helm-v0.9.0
```

## Required External Secrets

Production requires `auth.secretRef` and `external.postgres.urlSecret` to point at
operator-managed Secrets; inline database credentials are rejected at render time. The database
Secret must authenticate directly as the constrained `helix_app` role created by migrations—not as
the database owner or a role that can assume it. The migration Job receives the owner-capable
`helix_migrator` credential from `external.postgres.migrationUrlSecret` (or the CloudNativePG
owner Secret); application pods never receive it. See [Database](#database).
`publicUrl` must be one HTTPS origin. Redis and NATS may use their non-credentialed
internal URLs or their matching `urlSecret` entries. Object storage, Meilisearch,
KMS, and SIEM tokens are always read from Kubernetes Secrets.

The chart creates only `ClusterIP` Services and deny-by-default workload network
policies. Public HTTPS termination, SMTP edge, and Jitsi media ingress are separate
operator-managed gateways; the Helix application chart does not expose database,
queue, search, object-store, scanner, policy, or observability control planes.

## Availability and safe rollout

The default and role Deployments use zero-unavailable rolling
updates, advance one surge replica at a time, wait for a truthful readiness probe,
and stop after a finite progress deadline. Each workload has its own disruption
budget, soft zone and node spread, pod anti-affinity, a startup probe, and graceful
termination. Enterprise and sovereign clusters must pre-create the
`helix-workspace-critical` PriorityClass (or set `availability.priorityClassName` to
their managed equivalent).

Keep schema releases expand/contract: apply only backward-compatible additions with
the migration credential, roll the application, and remove obsolete schema no
earlier than the following release. Application pods never receive migration
authority and refuse startup while migrations are pending. Use Helm's atomic wait so
a failed one-replica-at-a-time rollout returns to the last revision:

```sh
helm upgrade --install helix ./infra/helm/helix \
  --atomic --wait --timeout 15m --values values-production.yaml
kubectl rollout status deployment/helix --timeout=10m
```

Before a zone or node drain, verify that every workload has replicas on distinct
nodes and that its disruption budget is healthy. Abort the drain if
`DISRUPTIONS ALLOWED` is zero for a workload that still needs eviction. Roll back an
application release—not a contracted schema—with `helm rollback helix <revision>
--wait --timeout 15m`.

Attach `infra/vault/helix-tenant-secrets.hcl` to the configured Vault workload role (substituting
`external.vault.byoStorageMount` when it is not `secret`). Helix persists only opaque secret handles;
the runtime constructs `tenants/{authenticated-org}/{scope}/{handle}` and the policy grants read-only,
single-segment access to those three server-owned scopes without tenant or secret listing.

Every app role is isolated by its exact release, role, and service-account
identity labels. Ingress is denied until an allowed source supplies an exact
namespace, service account, and non-empty pod-label selector. Egress defaults
to only the selected DNS pods on TCP/UDP 53. Public HTTPS is an explicit switch
whose rule excludes private, loopback, link-local/metadata, multicast, and
reserved ranges. Private endpoints must be single hosts (`/32` or `/128`) with
explicit TCP ports, so a compromised workload cannot scan a subnet.

For example, label the ingress controller pods with
`helix.io/service-account: ingress-nginx`, then allow that exact workload and a
single private Postgres endpoint:

```yaml
networkPolicy:
  application:
    ingress:
      - namespace: ingress-nginx
        serviceAccount: ingress-nginx
        podLabels:
          app.kubernetes.io/name: ingress-nginx
    egress:
      publicHttps: false
      endpoints:
        - cidr: 10.42.0.9/32
          ports: [5432]
      inCluster: []
```

Use `inCluster` instead of a CIDR when the destination is a pod workload; it
requires the same namespace + service-account identity label + pod-label
triple. The image verifier has a separate no-ingress policy and public HTTPS
access only to reach the registry. The sovereign overlay disables that public
rule, so its private registry must be supplied as a host endpoint. Plugins run
inside the selected Helix role and the Jitsi media plane is not deployed by
this chart; any future plugin/media `roleDeployments` entry automatically gets
its own policy.

Set `trustedProxies` to the exact ingress-proxy IPs or CIDRs. When it is empty Helix ignores all
forwarding headers; it never accepts proxy names, hop counts, or broad trust flags. Every IP-based
credential rule and audit record consumes Fastify's single normalized client address.

## Tier 4 FIPS/STIG Values

Every install must provide `image.digest` (or `fips.imageDigest` for the sovereign overlay) and pre-create the `helix-image-signing-key` Secret with its approved `cosign.pub`. A pre-install/pre-upgrade hook verifies the exact image's Cosign signature, SPDX SBOM attestation, and SLSA provenance attestation before Helm creates or updates application Deployments.

The sovereign overlay sets `fips.enabled=true`, `fips.crypto.mode=required`, and `stig.imagePolicy.requireDigest=true`. Supply the promoted internal-registry digest with `--set-string fips.imageDigest=sha256:<approved-image-digest>`. The rendered Deployment uses the FIPS image repository by digest and exposes the crypto adapter contract through `HELIX_FIPS_MODE`, `HELIX_CRYPTO_ADAPTER`, `HELIX_TLS_MIN_VERSION`, and `HELIX_TLS_ALLOWED_CIPHERS`.

The matching policy and evidence contracts live under `infra/security/tier4/`.

## Database

Helix needs PostgreSQL 18 with pgvector 0.8 or newer and the `vector`, `pgcrypto`, and `pg_trgm`
extensions. The full requirements, role model, startup checks, and external-PostgreSQL bootstrap
SQL are in [docs/deployment-production.md#database](../../../docs/deployment-production.md#database).

| Values                   | Database                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `values.yaml` (default)  | external PostgreSQL via `external.postgres.urlSecret` (`cloudnativepg.enabled: false`) |
| `values-enterprise.yaml` | in-chart CloudNativePG `Cluster`, managed roles, Barman Cloud Plugin backups and PITR  |

Production Compose is the 1.0 release path. On Kubernetes, CloudNativePG is the supported
database path; the default keeps it off so clusters without the operator can use an external
server.

### External PostgreSQL

Bootstrap the database once as a superuser with the SQL in the deployment guide, then provide two
Secrets:

- `external.postgres.urlSecret`: `DATABASE_URL` for `helix_app`; application pods receive only this.
- `external.postgres.migrationUrlSecret`: `HELIX_MIGRATION_DATABASE_URL` for `helix_migrator`;
  only the migration Job receives it. Without it the Job falls back to `DATABASE_URL`, which
  cannot apply migrations when that URL is the least-privileged `helix_app`.

Mount the server CA and set `POSTGRES_TLS_CA_FILE` through `extraVolumes`, `extraVolumeMounts`, and
`env`.

### CloudNativePG

Requires CloudNativePG 1.26 or newer and, with backups enabled, the Barman Cloud Plugin. Set
`cloudnativepg.enabled=true` to render:

- A `Cluster` running `cloudnativepg.image.repository@cloudnativepg.image.digest`: the
  `helix-workspace-postgres-cnpg` operand (CloudNativePG `minimal` PostgreSQL 18.6 plus pgvector
  0.8.5 from the Compose image's pinned source). The digest is required; tags and the legacy
  `cloudnativepg.imageName` are rejected.
- `bootstrap.initdb` with owner `helix_migrator` and `postInitApplicationSQL` that runs once as the
  superuser: creates `vector` and `pgcrypto`, creates the four Helix roles with the migration 0090
  attributes, grants `helix_migration_owner` to the owner, applies the function grants, then
  creates `pg_trgm`. Append site-specific statements with
  `cloudnativepg.bootstrap.extraPostInitApplicationSQL`.
- `managed.roles` for `helix_migration_owner` and the `helix_app`, `helix_worker`, and
  `helix_readonly` logins. The operator keeps their attributes reconciled and sets passwords from
  `cloudnativepg.roles.{app,worker,readonly}.passwordSecret` (type `kubernetes.io/basic-auth`,
  labelled `cnpg.io/reload: "true"`).
- The migration Job with `HELIX_MIGRATION_DATABASE_URL` from the operator-generated
  `<clusterName>-app` Secret (key `uri`, the `helix_migrator` login) unless
  `external.postgres.migrationUrlSecret` is set. On the first install the Job is a `post-install`
  hook, because the `Cluster` does not exist while pre-install hooks run, and the runner waits up to
  `migrations.databaseWaitSeconds` for it. Application pods restart until the schema is current, so
  do not combine the first install with `helm install --wait`. Upgrades run the Job `pre-upgrade`.
- With `cloudnativepg.clientTls.enabled` (default), the operator CA Secret `<clusterName>-ca` is
  mounted into application and migration pods and pinned with `POSTGRES_TLS_CA_FILE`.

Application pods read `DATABASE_URL` from `external.postgres.urlSecret`; on the enterprise overlay
that is the operator-provisioned `helix-postgres-runtime` Secret, whose URL must name `helix_app`
at `<clusterName>-rw` with the password from `helix-postgres-role-app`.

Backups and recovery:

- `cloudnativepg.backup.barmanObjectStore`: rendered as the `ObjectStore` `spec.configuration`
  (destination, endpoint such as RustFS or any S3 service, credentials, WAL and base-backup
  compression/encryption, `wal.archiveAdditionalCommandArgs`, `data.additionalCommandArgs`,
  tags). `serverName` becomes the Cluster plugin parameter. The retention policy moves to the
  `ObjectStore`.
- `cloudnativepg.scheduledBackup`: a daily `ScheduledBackup` with `method: plugin` in
  CloudNativePG's six-field cron format.
- `cloudnativepg.bootstrap.recovery` and `cloudnativepg.recovery.externalClusters` (`name`,
  `barmanObjectName`, `serverName`): PITR into a new cluster. A recovered cluster keeps its
  extensions and roles, so no bootstrap SQL runs.
- `cloudnativepg.tde`: TDE/KMS annotations and optional PostgreSQL parameters. PVC annotations are
  applied through `inheritedMetadata`, because a CloudNativePG `pvcTemplate` has no metadata.

### Upgrading to chart 1.0.0

Chart 1.0.0 changes CloudNativePG values incompatibly. The old image, WAL-argument, and recovery
keys fail rendering with an explicit message until they are migrated:

| Before (0.x)                                                                   | Chart 1.0.0                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudnativepg.imageName: ghcr.io/cloudnative-pg/postgresql:17`                | `cloudnativepg.image.repository` + `cloudnativepg.image.digest` (the published `helix-workspace-postgres-cnpg` digest, PostgreSQL 18) |
| `cloudnativepg.backup.barmanObjectStore.wal.additionalCommandArgs`             | `wal.archiveAdditionalCommandArgs` (and optional `wal.restoreAdditionalCommandArgs`)                                                  |
| `cloudnativepg.recovery.externalClusters[]` with an inline `barmanObjectStore` | `{name, barmanObjectName, serverName}`; `barmanObjectName` names an `ObjectStore` in the release namespace                            |
| in-core `spec.backup.barmanObjectStore`, `method: barmanObjectStore`           | Barman Cloud Plugin `ObjectStore`, Cluster `plugins`, `method: plugin` (install the plugin first)                                     |
| `cloudnativepg.bootstrap.owner: helix` (base values)                           | `helix_migrator`                                                                                                                      |

An existing PostgreSQL 17 CloudNativePG cluster cannot switch images in place: restore it into a
new PostgreSQL 18 cluster (dump/restore or `pg_upgrade`, as in the deployment guide), then run
`ALTER EXTENSION vector UPDATE`. The chart also adds `networkPolicy.migrate` (DNS and PostgreSQL
egress for the migration Job; list an external PostgreSQL host under `endpoints`, and with
`vault.agentInject` the exact Vault endpoint its agent needs) and sets
`HELIX_IMAGE` from the selected image digest.

For Tier 3, replace the example backup destination, object-store credentials Secret, storage-class/KMS annotations, and `--sse-kms-key-id` values with your cloud or on-prem KMS values before install.

`pnpm infra:helm:validate` renders the external and CloudNativePG paths (install, upgrade, and
recovery), asserts the bootstrap SQL, roles, plugin backups, hook ordering, and CA wiring, and
validates the CloudNativePG and Barman Cloud resources against their CRD schemas with kubeconform.
