# Helix Tier 4 Air-Gap Install Runbook

This runbook installs Helix into a **disconnected (air-gapped)** environment
using the Tier 4 sovereign overlay (`infra/helm/helix/values-sovereign.yaml`).
It is the operational companion to:

- `infra/security/tier4/airgap-manifest.yaml` — the transfer-bundle contract.
- `infra/security/tier4/fips-stig-adapter.yaml` — the FIPS/STIG contract.
- `infra/security/tier4/stig-hardening-profile.yaml` — the pod-hardening baseline.
- `docs/security/nist-800-53-mapping.md` — the control mapping.
- `docs/security/tier4-validation.md` — the validation evidence checklist.

Tier 4 is **opt-in**. None of the steps below affect a standard Helix install:
the default image and default Helm install ship with FIPS off, STIG off, and
open egress. Tier 4 is enabled only by the three explicit switches exercised in
this runbook — the STIG image, the sovereign overlay, and the FIPS config flag.

## Roles and prerequisites

| Environment | Purpose | Tools required |
| ----------- | ------- | -------------- |
| Build host (connected) | Assemble and sign the transfer bundle | `helm` ≥ 3.12, `docker`/`buildx`, `cosign`, an SBOM tool (`syft`), a scanner (`grype`/`trivy`), `shasum` |
| Disconnected cluster | Run Helix | Kubernetes ≥ 1.27, an internal OCI registry, a CNI supporting NetworkPolicy, an enforcing admission controller (Kyverno or Gatekeeper) |

You also need, inside the disconnected environment: an approved private
registry, FIPS-labeled worker nodes, and provisioned Postgres, Redis, NATS,
Meilisearch, S3-compatible WORM storage, KMS, Vault, and a SIEM endpoint.

---

## Stage 1 — Build the transfer bundle (connected host)

### 1.1 Package the chart and render the overlay

```sh
helm dependency build infra/helm/helix
helm package infra/helm/helix --version 0.9.0 --destination dist/airgap
helm template helix infra/helm/helix \
  -f infra/helm/helix/values-sovereign.yaml \
  > dist/airgap/helix-sovereign.rendered.yaml
cp infra/helm/helix/values-sovereign.yaml dist/airgap/
```

### 1.2 Build the STIG/FIPS image

The Tier 4 deployment uses the hardened image, **not** the default image.
Build it with a FIPS 140-3 validated runtime base pinned by digest:

```sh
docker build -f infra/docker/Dockerfile.stig \
  --build-arg RUNTIME_BASE=cgr.dev/chainguard/node-fips@sha256:<digest> \
  --build-arg BUILD_BASE=node@sha256:<digest> \
  -t registry.example.internal/helix/helix-fips:0.9.0 .
```

Record the resulting image digest:

```sh
docker inspect --format '{{index .RepoDigests 0}}' \
  registry.example.internal/helix/helix-fips:0.9.0
```

### 1.3 Generate supply-chain evidence

For the application image and every platform sidecar image
(vault-csi-provider, spire-agent, ingress-controller, policy-controller,
metrics-collector — see `airgap-manifest.yaml`):

```sh
syft <image> -o spdx-json > dist/airgap/sbom.spdx.json
grype <image> -o json > dist/airgap/vulnerability-scan.json
cosign sign --key <key> <image>
cosign verify --key <pub> <image> | tee dist/airgap/cosign-verify-images.txt
```

Write the digest map (`image-digest-map.yaml`, `platform-image-digests.yaml`)
so every image in the bundle is referenced by `repo@sha256:...`.

Vulnerability gate: the runtime image must carry **no unwaived High/Critical**
findings; the build image must carry **no unwaived Critical** findings.

### 1.4 Pin the digest in the overlay

Edit the copied `dist/airgap/values-sovereign.yaml` so `fips.imageDigest` holds
the real digest from step 1.2. The placeholder all-zero digest **must not** be
shipped — the STIG admission policy rejects it.

```yaml
fips:
  enabled: true
  imageRepository: registry.example.internal/helix/helix-fips
  imageDigest: sha256:<real-digest>
```

### 1.5 Assemble and checksum the bundle

Collect into `dist/airgap/` every file listed under
`transferBundle.requiredFiles` in `airgap-manifest.yaml`, plus the Tier 4
artifacts (`fips-stig-adapter.yaml`, `stig-hardening-profile.yaml`,
`airgap-manifest.yaml`) and `docs/security/tier4-validation.md`. Then:

```sh
(cd dist/airgap && find . -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 shasum -a 256 > SHA256SUMS)
```

Transfer `dist/airgap/` to the disconnected environment over the approved
medium.

---

## Stage 2 — Verify the bundle (disconnected environment)

Before importing anything, prove the bundle arrived intact:

```sh
(cd dist/airgap && shasum -a 256 -c SHA256SUMS)
```

Re-verify image signatures with the offline trust root:

```sh
cosign verify --key <offline-pub-key> \
  registry.example.internal/helix/helix-fips@sha256:<digest>
```

Stop and investigate on any checksum or signature mismatch — do not proceed.

---

## Stage 3 — Import images

Load each image into the approved internal registry **by digest**:

```sh
skopeo copy \
  docker-archive:helix-fips-0.9.0.tar \
  docker://registry.example.internal/helix/helix-fips:0.9.0
```

After import, confirm the digest is unchanged from `image-digest-map.yaml`.
Mutable tags such as `latest` must not be used as the deployed reference; the
chart consumes `repository@imageDigest`.

---

## Stage 4 — Prepare external services

Provision and document each private endpoint, then create the Kubernetes
Secrets the chart references (see `airgap-manifest.yaml`
`externalServices.requiredSecretRefs`):

| Service | Secret | Notes |
| ------- | ------ | ----- |
| Postgres / CloudNativePG | `helix-postgres-url` | Connection URL |
| Redis | `helix-redis-url` | If auth required |
| NATS | `helix-nats-url` | If auth required |
| Meilisearch | `helix-meili-key` | Master key |
| S3-compatible WORM | `helix-s3-access` / `helix-s3-secret` | Object-lock / retention enabled |
| KMS | `helix-kms` | Endpoint + key ID |
| Vault | (Kubernetes auth role) | CSI provider policy |
| SIEM | `helix-siem` | Ingestion token |

```sh
kubectl create namespace helix
kubectl label namespace helix \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted
kubectl -n helix create secret generic helix-postgres-url \
  --from-literal=url='postgres://...'
# ...repeat for each secret above.
```

### Egress posture

The sovereign overlay sets **default-deny** egress (`networkPolicy.egress`
allows no CIDRs and no DNS). Add the approved private-endpoint CIDRs explicitly:

```sh
helm upgrade ... \
  --set networkPolicy.egress.cidrs='{10.20.0.0/16,10.30.0.0/16}'
```

or keep default-deny and apply a CNI-specific FQDN egress policy outside this
chart. Do not set `networkPolicy.egress.allowAll=true` in Tier 4.

---

## Stage 5 — Install

```sh
helm upgrade --install helix ./helix-0.9.0.tgz \
  --namespace helix \
  -f values-sovereign.yaml \
  --set fips.imageDigest=sha256:<real-digest> \
  --set external.postgres.urlSecret.name=helix-postgres-url
```

The rendered Deployment will:

- pull `registry.example.internal/helix/helix-fips@sha256:<digest>`;
- schedule only on nodes labeled `node-restriction.kubernetes.io/fips=true`;
- set `HELIX_FIPS_MODE=required` and `HELIX_CRYPTO_ADAPTER=node-openssl-fips`
  from the ConfigMap, activating `FipsCryptoProvider` in fail-closed mode.

> Opt-in note: these FIPS ConfigMap keys and container env vars are emitted
> **only** because `fips.enabled=true` in the sovereign overlay. A default
> `helm install` renders no `HELIX_FIPS_*` keys at all and runs the standard,
> byte-identical `NodeCryptoProvider`.

---

## Stage 6 — Validate before production traffic

Run every check; record output as evidence (Stage 7).

| Check | Pass condition |
| ----- | -------------- |
| `helm lint infra/helm/helix -f values-sovereign.yaml` | No failures |
| `helm template ... -f values-sovereign.yaml` | FIPS image referenced **by digest** |
| Kubernetes schema validation of rendered manifests | Valid |
| Admission policy scan | No privileged pods, host namespaces, hostPath, or mutable tags |
| Placeholder-digest / unsigned-image check | Rejected by policy |
| `kubectl -n helix get pods -o wide` | All pods on FIPS-labeled nodes |
| `kubectl -n helix get configmap helix-config -o yaml` | `HELIX_FIPS_MODE=required`, FIPS adapter, approved cipher list |
| Crypto adapter self-test | `FipsCryptoProvider` status `selfTestPassed=true`, `opensslFipsActive=true` |
| Vault CSI mount | Secret material present and rotating |
| SPIRE | Workload SVIDs issued for Helix pods |
| SIEM | Signed audit test event received with trace correlation fields |
| WORM retention | Deletion of an audit object is blocked |
| DR restore | Restore test completes from approved backups |

If FIPS mode cannot be satisfied the pod fails closed at first crypto use with
`HELIX_CRYPTO_FIPS_INIT_FAILED` — this is expected behavior on a non-FIPS
runtime and indicates the node/base image is not FIPS-validated.

---

## Stage 7 — Collect evidence

Store the completed bundle under the evidence path named in
`fips-stig-adapter.yaml` (`evidence.storage.path: evidence/tier4`). Include:

- chart-package, rendered-manifest, and bundle checksums;
- image digest map, SBOMs, vulnerability scan reports, signature verification;
- FIPS runtime attestation (`fips-runtime-attestation.json`);
- STIG/admission policy report;
- NetworkPolicy review;
- SIEM ingestion proof and WORM retention proof;
- DR restore record;
- operator sign-off (`operator-signoff.md`).

See `docs/security/tier4-validation.md` for the full evidence checklist.

---

## Rollback

Tier 4 install issues are remediated by:

```sh
helm rollback helix <previous-revision> --namespace helix
```

or, for a clean removal, `helm uninstall helix -n helix` followed by deletion
of the namespace. External Secrets and provisioned services are not managed by
the chart and are retained. Because the deployed image is digest-pinned, a
rollback always returns to a known, attested artifact.

## Upgrades

Repeat Stage 1 for the new version on the connected host, transfer and verify a
fresh bundle (Stage 2), import the new digest (Stage 3), and `helm upgrade` with
the new `fips.imageDigest`. Never mutate an in-cluster image tag in place.
