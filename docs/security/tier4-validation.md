# Tier 4 Validation

This checklist validates the TASK-A03 sovereign overlay without requiring Docker. It assumes the chart, Tier 4 YAML, and disconnected bundle are already present on the validation host.

## Static Contract Checks

Run these checks before transferring the bundle:

```sh
pnpm infra:helm:validate
yamllint infra/security/tier4 infra/helm/helix/values.yaml infra/helm/helix/values-sovereign.yaml
helm lint infra/helm/helix -f infra/helm/helix/values-sovereign.yaml
helm template helix infra/helm/helix -f infra/helm/helix/values-sovereign.yaml > dist/airgap/helix-sovereign.rendered.yaml
```

`pnpm infra:helm:validate` is the repository-level offline gate for the Helm overlays. It renders
base, business, enterprise, and sovereign profiles, confirms HPA/PDB/NetworkPolicy coverage, checks
CloudNativePG backup/PITR evidence for enterprise, and verifies the sovereign FIPS/STIG/air-gap
contract including default-deny egress.

If an approved Kubernetes schema validator is available in the environment, validate the rendered manifest:

```sh
kubeconform -strict -ignore-missing-schemas dist/airgap/helix-sovereign.rendered.yaml
```

## FIPS Crypto Adapter Gates

The rendered ConfigMap and Deployment must carry the FIPS contract from `infra/security/tier4/fips-stig-adapter.yaml`:

- `HELIX_FIPS_MODE` is `required`.
- `HELIX_CRYPTO_ADAPTER` is `node-openssl-fips`.
- `HELIX_TLS_MIN_VERSION` is `1.2` or stricter.
- `HELIX_TLS_ALLOWED_CIPHERS` contains only the approved cipher suites.
- The workload has the FIPS node selector `node-restriction.kubernetes.io/fips=true`.
- Runtime evidence includes `fips-runtime-attestation.json` with node label, OpenSSL FIPS provider, adapter self-test, and TLS policy checks.

## STIG Image Gates

The sovereign overlay enables `stig.imagePolicy.requireDigest=true`. Before production traffic:

- Replace the placeholder zero `fips.imageDigest` with the promoted internal digest.
- Confirm the rendered image uses `registry.example.internal/helix/helix-fips@sha256:<digest>`.
- Reject `latest`, mutable tags, placeholder digests, and images outside the approved internal registry.
- Verify signatures offline and save output as `cosign-verify-images.txt`.
- Include `sbom.spdx.json` or `sbom.cyclonedx.json` for each image.
- Include vulnerability scan output and fail on unfixed critical or exploitable high findings.

## Air-Gap Bundle Gates

Use `infra/security/tier4/airgap-manifest.yaml` as the inventory of required files. The bundle must include:

- Chart package, sovereign values, rendered manifest, and `SHA256SUMS`.
- Application and platform image digest maps.
- Signature verification output.
- SBOM and vulnerability reports.
- FIPS runtime attestation.
- STIG/admission policy report.
- Network policy review.
- SIEM ingestion test result.
- Operator sign-off.

Inside the disconnected environment, verify checksums before install:

```sh
(cd dist/airgap && shasum -a 256 -c SHA256SUMS)
```

## Production Acceptance

Production traffic is blocked until these outcomes are recorded in the Tier 4 evidence path:

- Helm lint and render output for the final overlay.
- Kubernetes schema validation or approved equivalent.
- Admission/STIG policy pass report.
- FIPS runtime attestation pass report.
- SIEM audit event proof with trace and hash-chain fields.
- WORM object-store deletion denial proof.
- Restore test result from approved backups.
