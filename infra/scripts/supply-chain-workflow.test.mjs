import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(".github/workflows/supply-chain-security.yml"), "utf8");
const checkoutEditors = readFileSync(
  resolve(".github/actions/checkout-editors/action.yml"),
  "utf8",
);
const secretBaseline = readFileSync(resolve(".gitleaksignore"), "utf8").trim().split("\n");
const workflowSources = readdirSync(resolve(".github"), { recursive: true })
  .filter((path) => typeof path === "string" && /\.ya?ml$/u.test(path))
  .map((path) => ({
    path,
    source: readFileSync(resolve(".github", path), "utf8"),
  }));

describe("source supply-chain workflow", () => {
  it("runs the pinned, fail-closed production dependency audit", () => {
    expect(source).toContain("uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkoutEditors).toContain(
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(source).toContain("uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271");
    expect(source).toContain("version: 11.18.0");
    expect(source).toContain("uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(source).toContain("run: pnpm quality:production-dependency-audit");
    expect(source).not.toContain("--ignore-registry-errors");
    expect(source).not.toContain("continue-on-error");
  });

  it("uses an immutable Gitleaks image for fail-closed full-history secret scanning", () => {
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain(
      "ghcr.io/gitleaks/gitleaks@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9",
    );
    expect(source).toContain("git config --global --add safe.directory /repo");
    expect(source).toContain('test "$(git rev-parse --is-inside-work-tree)" = true');
    expect(source).toContain('test -n "$(git rev-list -1 --all)"');
    expect(source).toContain("gitleaks git .");
    expect(source).toContain("--exit-code 1");
    expect(source).not.toContain("trufflehog");
    expect(source).toContain('cron: "17 6 * * *"');
  });

  it("uses only exact secret fingerprints in the historical baseline", () => {
    expect(secretBaseline).toHaveLength(65);
    expect(new Set(secretBaseline).size).toBe(secretBaseline.length);
    for (const fingerprint of secretBaseline) {
      expect(fingerprint).toMatch(/^[0-9a-f]{40}:[^:*?\n]+:[a-z0-9-]+:[1-9][0-9]*$/u);
    }
    expect(secretBaseline.filter((fingerprint) => fingerprint.includes(":private-key:"))).toEqual([
      "b7758ad88dc9894ad52993de0370e7fc5abbfccb:infra/meet/config/prosody/certs/auth.meet.jitsi.key:private-key:1",
      "b7758ad88dc9894ad52993de0370e7fc5abbfccb:infra/meet/config/prosody/certs/internal-muc.meet.jitsi.key:private-key:1",
      "b7758ad88dc9894ad52993de0370e7fc5abbfccb:infra/meet/config/prosody/certs/meet.jitsi.key:private-key:1",
      "b7758ad88dc9894ad52993de0370e7fc5abbfccb:infra/meet/config/prosody/certs/muc.meet.jitsi.key:private-key:1",
      "b7758ad88dc9894ad52993de0370e7fc5abbfccb:infra/meet/config/web/keys/cert.key:private-key:1",
    ]);
  });

  it("pins every external workflow and composite-action dependency to a commit", () => {
    for (const workflow of workflowSources) {
      for (const match of workflow.source.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/gu)) {
        const [, action, reference] = match;
        if (action.startsWith("./")) continue;
        expect(reference, `${workflow.path}: ${action}`).toMatch(/^[0-9a-f]{40}$/u);
      }
    }
  });

  it("keeps the workflow token read-only", () => {
    const permissions = source.slice(source.indexOf("permissions:"), source.indexOf("\njobs:"));
    expect(permissions).toContain("contents: read");
    expect(permissions).not.toContain("write");
  });
});
