import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(".github/workflows/production-image-security.yml"), "utf8");

describe("production image supply-chain workflow", () => {
  it("grants only the permissions required for registry provenance", () => {
    const permissions = source.slice(source.indexOf("permissions:"), source.indexOf("\njobs:"));
    expect(permissions).toContain("contents: read");
    expect(permissions).toContain("packages: write");
    expect(permissions).toContain("id-token: write");
    expect(permissions).toContain("attestations: write");
    expect(permissions).toContain("artifact-metadata: write");
    expect(permissions).not.toContain("actions: write");
  });

  it("scans both images before immutable publication", () => {
    const publishIndex = source.indexOf("name: Push immutable reviewed images");
    expect(publishIndex).toBeGreaterThan(
      source.indexOf("name: Scan application image for high and critical vulnerabilities"),
    );
    expect(publishIndex).toBeGreaterThan(
      source.indexOf("name: Scan web image for high and critical vulnerabilities"),
    );
    const publishStep = source.slice(
      publishIndex,
      source.indexOf("\n      - name:", publishIndex + 1),
    );
    expect(publishStep).toContain("refs/heads/main");
    expect(publishStep).toContain("${GITHUB_SHA}");
    expect(publishStep).toContain("sha256:[a-f0-9]{64}");
  });

  it("uses GitHub's signed provenance action for both pushed digests", () => {
    expect(
      source.match(/uses: actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/gu),
    ).toHaveLength(4);
    expect(source).toContain("subject-digest: ${{ steps.push-images.outputs.app_digest }}");
    expect(source).toContain("subject-digest: ${{ steps.push-images.outputs.web_digest }}");
    expect(source.match(/push-to-registry: true/gu)).toHaveLength(4);
    expect(source).toContain(
      "subject-name: ghcr.io/${{ github.repository_owner }}/helix-workspace",
    );
    expect(source).toContain(
      "subject-name: ghcr.io/${{ github.repository_owner }}/helix-workspace-web",
    );
  });

  it("attests both SPDX documents against the exact pushed image digests", () => {
    expect(source).toContain("name: Sign application image SBOM");
    expect(source).toContain("name: Sign web image SBOM");
    expect(source).toContain("sbom-path: helix-all/helix-workspace/helix-workspace.spdx.json");
    expect(source).toContain("sbom-path: helix-all/helix-workspace/helix-workspace-web.spdx.json");
    expect(
      source.split("subject-digest: ${{ steps.push-images.outputs.app_digest }}"),
    ).toHaveLength(3);
    expect(
      source.split("subject-digest: ${{ steps.push-images.outputs.web_digest }}"),
    ).toHaveLength(3);
  });

  it("retains raw SBOMs and signed attestation bundles as release evidence", () => {
    expect(source).toContain("name: Upload image supply-chain evidence");
    expect(source).toContain("helix-workspace-supply-chain-evidence-${{ github.sha }}");
    expect(source).toContain("${{ steps.app-provenance.outputs.bundle-path }}");
    expect(source).toContain("${{ steps.web-provenance.outputs.bundle-path }}");
    expect(source).toContain("${{ steps.app-sbom-attestation.outputs.bundle-path }}");
    expect(source).toContain("${{ steps.web-sbom-attestation.outputs.bundle-path }}");
    expect(source).toContain("if-no-files-found: error");
    expect(source).toContain("retention-days: 90");
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
});
