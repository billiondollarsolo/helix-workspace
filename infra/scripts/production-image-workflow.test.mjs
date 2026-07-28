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
    expect(source.match(/uses: actions\/attest@v4/gu)).toHaveLength(2);
    expect(source).toContain("subject-digest: ${{ steps.push-images.outputs.app_digest }}");
    expect(source).toContain("subject-digest: ${{ steps.push-images.outputs.web_digest }}");
    expect(source.match(/push-to-registry: true/gu)).toHaveLength(2);
    expect(source).toContain(
      "subject-name: ghcr.io/${{ github.repository_owner }}/helix-workspace",
    );
    expect(source).toContain(
      "subject-name: ghcr.io/${{ github.repository_owner }}/helix-workspace-web",
    );
  });
});
