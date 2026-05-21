# Tier 4 Security Artifacts

This directory contains declarative security inputs for TASK-A03 sovereign deployments. Treat these files as release-gate contracts for Helm rendering, admission policy, image promotion, evidence collection, and accreditation review.

- `fips-stig-adapter.yaml`: FIPS crypto adapter interface, required runtime configuration keys, STIG release gates, and evidence bundle requirements.
- `stig-hardening-profile.yaml`: Kubernetes and image hardening profile that can be translated to Kyverno, Gatekeeper, or a managed admission policy service.
- `airgap-manifest.yaml`: Disconnected transfer manifest, required bundle contents, private service dependencies, and install checklist.

The Helm sovereign overlay at `infra/helm/helix/values-sovereign.yaml` implements the application-side defaults these profiles expect: SPIRE enabled, Vault CSI enabled, KMS and SIEM endpoints enabled, digest-pinned FIPS image selection, FIPS node targeting, STIG image policy, and default-deny egress.

Before production use, replace the placeholder `fips.imageDigest` in the sovereign overlay with the promoted internal-registry digest and include matching signature, SBOM, vulnerability, and runtime-attestation evidence.
