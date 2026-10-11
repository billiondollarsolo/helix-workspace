import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const source = readFileSync(resolve(".github/workflows/production-image-security.yml"), "utf8");
const dockerfile = readFileSync(resolve("infra/docker/Dockerfile"), "utf8");
function dockerStage(name) {
  const start = dockerfile.indexOf(` AS ${name}`);
  const end = dockerfile.indexOf("\nFROM ", start);
  expect(start, `missing ${name} stage`).toBeGreaterThan(-1);
  return dockerfile.slice(start, end === -1 ? undefined : end);
}
describe("production image supply-chain workflow", () => {
  it("rebuilds images when a patched dependency changes", () => {
    expect(source.match(/- "patches\/\*\*"/gu)).toHaveLength(2);
    expect(source.match(/- "docker-compose\.yml"/gu)).toHaveLength(2);
    expect(source.match(/- "docker-compose\.production\.yml"/gu)).toHaveLength(2);
    for (const directory of [
      "cerbos",
      "clamav",
      "meilisearch",
      "nats",
      "postgres",
      "spamassassin",
    ]) {
      expect(source.match(new RegExp(`- "infra/${directory}/\\*\\*"`, "gu"))).toHaveLength(2);
    }
    expect(source.match(/- "infra\/scripts\/normalize-image-spdx\.mjs"/gu)).toHaveLength(2);
  });
  it("grants only the permissions required for registry provenance", () => {
    const permissions = source.slice(source.indexOf("permissions:"), source.indexOf("\njobs:"));
    expect(permissions).toContain("contents: read");
    expect(permissions).toContain("packages: write");
    expect(permissions).toContain("id-token: write");
    expect(permissions).toContain("attestations: write");
    expect(permissions).toContain("artifact-metadata: write");
    expect(permissions).not.toContain("actions: write");
  });
  it("publishes only after the complete application and dependency inventory succeeds", () => {
    const publishJobIndex = source.indexOf("\n  publish-reviewed-images:");
    const prePublicationJobs = source.slice(0, publishJobIndex);
    const publishJob = source.slice(publishJobIndex);
    expect(publishJobIndex).toBeGreaterThan(
      source.indexOf("name: Scan application image for high and critical vulnerabilities"),
    );
    expect(publishJobIndex).toBeGreaterThan(
      source.indexOf("name: Scan dependency image for high and critical vulnerabilities"),
    );
    expect(publishJob).toContain("needs:");
    expect(publishJob).toContain("- build-sbom-scan");
    expect(publishJob).toContain("- dependency-sbom-scan");
    expect(publishJob).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(prePublicationJobs).not.toContain("docker push");
    expect(prePublicationJobs).not.toContain("docker/login-action");
    expect(publishJob).toContain("name: Push exact reviewed image");
    expect(publishJob).toContain("${GITHUB_SHA}");
    expect(publishJob).toContain("sha256:[a-f0-9]{64}");
  });
  it("publishes and attests only locally built production images", () => {
    const publishJob = source.slice(source.indexOf("\n  publish-reviewed-images:"));
    const candidates = [...publishJob.matchAll(/^\s+- candidate: (\S+)$/gmu)].map(
      (match) => match[1],
    );
    expect(candidates).toEqual([
      "app",
      "web",
      "postgres",
      "postgres-cnpg",
      "nats",
      "meilisearch",
      "cerbos",
      "spamassassin",
      "clamav",
    ]);
    expect(publishJob).not.toMatch(/candidate: (?:redis|rustfs)/u);
    expect(
      source.match(/uses: actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/gu),
    ).toHaveLength(3);
    expect(source.match(/push-to-registry: true/gu)).toHaveLength(3);
    expect(publishJob).toContain(
      "subject-name: ghcr.io/${{ github.repository_owner }}/${{ matrix.registry_name }}",
    );
    expect(
      publishJob.split("subject-digest: ${{ steps.push-image.outputs.image_digest }}"),
    ).toHaveLength(4);
  });
  it("publishes the exact scanned archives without rebuilding them", () => {
    const publishJob = source.slice(source.indexOf("\n  publish-reviewed-images:"));
    expect(source).toContain("name: Export exact reviewed application candidates");
    expect(source).toContain("name: Export exact reviewed dependency candidate");
    expect(source).toContain("name: Record exact application images selected for review");
    expect(source).toContain("name: Record exact dependency image selected for review");
    expect(source.match(/\[\[ "\$current_image_id" == "\$reviewed_image_id" \]\]/gu)).toHaveLength(
      2,
    );
    expect(source.match(/docker save --output/gu)).toHaveLength(2);
    expect(source).toContain('sha256sum --check "${candidate}.files.sha256"');
    expect(source.split('"${candidate}.spdx.json"')).toHaveLength(5);
    expect(source.split('"${candidate}.trivy.json"')).toHaveLength(4);
    expect(source).toContain(
      '[[ "$(<"${candidate_dir}/${candidate}.source-sha")" == "$GITHUB_SHA" ]]',
    );
    expect(source).toContain('loaded_image_id="$(docker image inspect');
    expect(source).toContain('[[ "$loaded_image_id" == "$expected_image_id" ]]');
    expect(publishJob).toContain("docker load --input");
    expect(publishJob).not.toContain("docker build");
    expect(publishJob).not.toContain("docker pull");
    expect(publishJob).toContain(
      "sbom-path: publication-candidate/${{ matrix.candidate }}.normalized.spdx.json",
    );
    expect(publishJob).toContain("name: Normalize exact pushed image SPDX SBOM");
    expect(publishJob).toContain('--image-digest "${{ steps.push-image.outputs.image_digest }}"');
    expect(publishJob).toContain("publication-candidate/${{ matrix.candidate }}.spdx.json");
    expect(publishJob).toContain(
      "publication-candidate/${{ matrix.candidate }}.normalized.spdx.json",
    );
    expect(publishJob).toContain(
      "publication-candidate/${{ matrix.candidate }}.normalized.spdx.json.sha256",
    );
  });
  it("binds app and web attestations to the exact workspace source", () => {
    const publishJob = source.slice(source.indexOf("\n  publish-reviewed-images:"));
    expect(source).toContain('"${candidate}.source-provenance.json"');
    expect(source).toContain("schemaVersion: 1");
    expect(source).toContain("repository: process.env.WORKSPACE_REPOSITORY");
    expect(publishJob.match(/workspace_source: true/gu)).toHaveLength(2);
    expect(publishJob.match(/workspace_source: false/gu)).toHaveLength(7);
    expect(publishJob).toContain("name: Verify workspace application source predicate");
    expect(publishJob).toContain("name: Sign workspace application source provenance");
    expect(publishJob).toContain(
      "predicate-type: https://helix.billiondollarsolo.com/attestations/source-provenance/v1",
    );
    expect(publishJob).toContain(
      "predicate-path: publication-candidate/${{ matrix.candidate }}.source-provenance.json",
    );
    expect(publishJob).toContain("${{ steps.source-provenance-attestation.outputs.bundle-path }}");
    expect(publishJob).toContain("name: Wrap source provenance as release evidence");
    expect(publishJob).toContain(
      "RAW_BUNDLE_PATH: ${{ steps.source-provenance-attestation.outputs.bundle-path }}",
    );
    expect(publishJob).toContain('schema: "helix.evidence.github-sigstore-image-provenance.v1"');
    expect(publishJob).toContain(
      'bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"',
    );
    expect(publishJob).toContain('envelope?.payloadType !== "application/vnd.in-toto+json"');
    expect(publishJob).toContain("subjects[0].name !== process.env.SUBJECT_NAME");
    expect(publishJob).toContain("generatedAt: generatedAt.toISOString()");
    expect(publishJob).toContain("subjectName: process.env.SUBJECT_NAME");
    expect(publishJob).toContain("subjectDigest: process.env.SUBJECT_DIGEST");
    expect(publishJob).toContain('release_name="application"');
    expect(publishJob).toContain('release_name="web"');
    expect(publishJob).toContain('sha256sum "${release_name}-image-provenance.json"');
    expect(publishJob).toContain("publication-candidate/*-image-provenance.json");
    expect(publishJob).toContain("publication-candidate/*-image-provenance.json.sha256");
  });
  it("retains raw SBOMs and signed attestation bundles as release evidence", () => {
    expect(source).toContain("name: Upload image supply-chain evidence");
    expect(source).toContain("helix-workspace-supply-chain-evidence-${{ github.sha }}");
    expect(source).toContain("name: Upload published image attestations");
    expect(source).toContain("${{ steps.provenance.outputs.bundle-path }}");
    expect(source).toContain("${{ steps.sbom-attestation.outputs.bundle-path }}");
    expect(source).toContain("helix-all/helix-workspace/helix-workspace.trivy.json");
    expect(source).toContain("helix-all/helix-workspace/helix-workspace-web.trivy.json");
    expect(source).toContain("if-no-files-found: error");
    expect(source).toContain("retention-days: 90");
  });
  it("retains machine-readable scan output while failing on high and critical findings", () => {
    expect(source.match(/format: json/gu)).toHaveLength(3);
    expect(source.match(/exit-code: "1"/gu)).toHaveLength(3);
    expect(source.match(/ignore-unfixed: false/gu)).toHaveLength(3);
    expect(source.match(/severity: HIGH,CRITICAL/gu)).toHaveLength(3);
    expect(source).toContain("output: helix-all/helix-workspace/helix-workspace.trivy.json");
    expect(source).toContain("output: helix-all/helix-workspace/helix-workspace-web.trivy.json");
    expect(source.match(/steps\.build-app\.outcome == 'success'/gu)).toHaveLength(2);
    expect(source.match(/steps\.build-web\.outcome == 'success'/gu)).toHaveLength(2);
  });
  it("reruns image security when production deployment pruning changes", () => {
    expect(source.match(/"infra\/scripts\/prune-production-deploy\.mjs"/gu)).toHaveLength(2);
  });
  it("builds or pulls, scans, and retains an SBOM for the exact production dependency inventory", () => {
    const inventory = [...source.matchAll(/^\s+- inventory_name: (\S+)$/gmu)].map(
      (match) => match[1],
    );
    expect(inventory).toEqual([
      "postgres",
      "postgres-cnpg",
      "redis",
      "nats",
      "meilisearch",
      "rustfs",
      "cerbos",
      "spamassassin",
      "clamav",
    ]);
    expect(source).toContain("docker buildx build");
    expect(source).toContain("dockerfile: infra/postgres/Dockerfile.cnpg");
    expect(source).toContain(
      `--file "\${{ matrix.dockerfile || format('{0}/Dockerfile', matrix.context) }}"`,
    );
    expect(source).toContain('docker pull "${{ matrix.image }}"');
    expect(source).toContain("output-file: helix-workspace/${{ matrix.inventory_name }}.spdx.json");
    expect(source).toContain("output: helix-workspace/${{ matrix.inventory_name }}.trivy.json");
    expect(source).toContain("name: Export exact reviewed dependency candidate");
    expect(source.indexOf("name: Export exact reviewed dependency candidate")).toBeGreaterThan(
      source.indexOf("name: Scan dependency image for high and critical vulnerabilities"),
    );
    expect(source).toContain("matrix.source == 'build'");
    expect(source).toContain("helix-workspace-${{ matrix.inventory_name }}-publication-candidate");
    expect(source).toContain("name: Normalize exact pulled dependency SPDX SBOM");
    for (const [name, subject, digest] of [
      [
        "redis",
        "docker.io/library/redis",
        "sha256:0b2b77d3ea5078274795e3177cdbdada8b96316684a38911d528534ed679b5ec",
      ],
      [
        "rustfs",
        "docker.io/rustfs/rustfs",
        "sha256:41fe89380f4120a337790c02af192c3fe7bb55c3edc2e6e9357b487b47c6ab21",
      ],
    ]) {
      const entry = source.slice(
        source.indexOf(`- inventory_name: ${name}`),
        source.indexOf(
          "\n          - inventory_name:",
          source.indexOf(`- inventory_name: ${name}`),
        ),
      );
      expect(entry).toContain(`registry_subject: ${subject}`);
      expect(entry).toContain(`digest: ${digest}`);
    }
    expect(source).toContain("helix-workspace/${{ matrix.inventory_name }}.normalized.spdx.json");
    expect(source).toContain(
      "helix-workspace/${{ matrix.inventory_name }}.normalized.spdx.json.sha256",
    );
    expect(source).toContain("if-no-files-found: error");
  });
  it("pins every external action to an immutable commit", () => {
    const externalUses = [...source.matchAll(/uses: ([^./][^\s]+)(?:\s+#.*)?$/gmu)].map(
      (match) => match[1],
    );
    expect(externalUses.length).toBeGreaterThan(0);
    for (const action of externalUses) {
      expect(action).toMatch(/@[a-f0-9]{40}$/u);
    }
  });
  it("uses a pinned minimal application runtime and prunes unreachable build dependencies", () => {
    expect(dockerfile).toContain(
      "ARG RUNTIME_BASE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e",
    );
    expect(dockerfile).toContain("node infra/scripts/prune-production-deploy.mjs /app/deploy");
    const runtime = dockerStage("runtime");
    expect(runtime).toContain('ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]');
    expect(runtime).toContain("USER 10001:10001");
    expect(runtime).not.toContain("groupadd");
    expect(runtime).not.toContain("useradd");
    expect(runtime).not.toContain("npm ");
    expect(runtime).not.toContain("pnpm ");
  });
});
