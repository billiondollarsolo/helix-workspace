import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findAdrErrors,
  findBrokenLocalLinks,
  findClaimErrors,
  findScopeErrors,
  verifyLaunchDocumentation,
} from "./verify-launch-docs.mjs";
const workspaceRoot = new URL("../..", import.meta.url).pathname;
describe("verify-launch-docs", () => {
  it("keeps the checked-in launch documents, ADR inventory, and links consistent", async () => {
    await expect(verifyLaunchDocumentation(workspaceRoot)).resolves.toEqual([]);
  });
  it("rejects a launch scope that enables dormant apps or changes the exact app list", async () => {
    const scope = await readFile(join(workspaceRoot, "docs/release/1.0-scope.md"), "utf8");
    expect(findScopeErrors("docs/release/1.0-scope.md", scope, scope)).toEqual([]);
    const changed = scope
      .replace(
        "HELIX_APPS=mail,drive,chat,assistant",
        "HELIX_APPS=mail,drive,chat,calendar,assistant",
      )
      .replace("Calendar and Meet are dormant", "Calendar and Meet are shipped");
    expect(findScopeErrors("README.md", changed, scope)).toEqual(
      expect.arrayContaining([
        "README.md: scope mismatch: exact production apps",
        "README.md: scope mismatch: dormant Calendar and Meet",
        "README.md: production app list differs from canonical scope",
        "README.md: missing canonical scope link",
      ]),
    );
  });
  it("reports missing and prohibited launch claims", () => {
    const errors = findClaimErrors(
      "README.md",
      "Helix is production-ready for public multi-tenant SaaS. Chat is end-to-end encrypted.",
    );
    expect(errors).toContain(
      "README.md: prohibited unqualified claim: public multi-tenant SaaS launch readiness",
    );
    expect(errors).toContain("README.md: prohibited unqualified claim: E2EE chat");
    expect(errors).toContain("README.md: missing required claim: managed outbound provider");
    expect(errors).toContain("README.md: missing required claim: no Helix-hosted IMAP server");
  });
  it("requires the complete accepted ADR shape and plan mapping", () => {
    const errors = findAdrErrors(
      "docs/architecture/adr-0001-example.md",
      "# ADR-0001\n\n- **Status:** Proposed\n\n## Context\n",
      1,
    );
    expect(errors).toContain("docs/architecture/adr-0001-example.md: ADR status must be Accepted");
    expect(errors).toContain("docs/architecture/adr-0001-example.md: ADR must map to RD-1");
    expect(errors).toContain(
      "docs/architecture/adr-0001-example.md: missing ADR section: ## Reversal triggers",
    );
  });
  it("reports missing local Markdown link targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "helix-launch-docs-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/existing.md"), "# Existing\n");
    const sources = new Map([
      [
        "README.md",
        [
          "[Existing](docs/existing.md)",
          "[Missing](docs/missing.md)",
          "[Anchor](#local)",
          "[External](https://example.test/)",
        ].join("\n"),
      ],
    ]);
    await expect(findBrokenLocalLinks(root, sources)).resolves.toEqual([
      "README.md: broken local link: docs/missing.md",
    ]);
  });
});
