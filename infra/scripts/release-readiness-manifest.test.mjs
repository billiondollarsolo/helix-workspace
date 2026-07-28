import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReleaseReadinessManifest,
  parseArgs,
  redactSensitive,
} from "./release-readiness-manifest.mjs";

describe("release-readiness manifest", () => {
  it("redacts sensitive keys recursively and case-insensitively", () => {
    expect(
      redactSensitive({
        nested: {
          Password: "one",
          apiTOKENValue: "two",
          safe: [{ authorizationHeader: "three" }, { status: "ok" }],
        },
        Cookie: "four",
        publicKey: "five",
      }),
    ).toEqual({
      nested: {
        Password: "[REDACTED]",
        apiTOKENValue: "[REDACTED]",
        safe: [{ authorizationHeader: "[REDACTED]" }, { status: "ok" }],
      },
      Cookie: "[REDACTED]",
      publicKey: "[REDACTED]",
    });
  });

  it("creates a deterministic manifest for clean paired repositories", async () => {
    const fixture = await createFixture();
    const options = parseArgs(
      [
        "--workspace-dir",
        fixture.workspace,
        "--editors-dir",
        fixture.editors,
        "--evidence-dir",
        fixture.evidence,
        "--require-evidence",
        "tests/unit.json",
        "--timestamp",
        "2026-07-28T20:00:00.000Z",
        "--image-digest",
        `sha256:${"a".repeat(64)}`,
      ],
      fixture.root,
      {
        HELIX_MODE: "single-tenant",
        HELIX_SECURITY_TIER: "business",
        HELIX_ENABLED_APPS: "drive,mail,chat,drive",
        HELIX_ENABLED_FEATURES: "agent-approvals,malware-scan",
      },
    );

    const first = await buildReleaseReadinessManifest(options);
    const second = await buildReleaseReadinessManifest(options);

    expect(second).toEqual(first);
    expect(first.generatedAt).toBe("2026-07-28T20:00:00.000Z");
    expect(first.repositories.workspace.dirty).toBe(false);
    expect(first.repositories.editors.dirty).toBe(false);
    expect(first.database.migrationHead).toBe("0002_second.sql");
    expect(first.deployment).toMatchObject({
      mode: "single-tenant",
      securityTier: "business",
      enabledApps: ["chat", "drive", "mail"],
      imageDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(first.evidence.files).toEqual([
      {
        path: "tests/unit.json",
        bytes: 12,
        sha256: "e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726",
      },
    ]);
  });

  it("fails closed for dirty repositories and missing required evidence", async () => {
    const dirtyFixture = await createFixture();
    await writeFile(resolve(dirtyFixture.workspace, "dirty.txt"), "dirty\n", "utf8");
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [
            "--workspace-dir",
            dirtyFixture.workspace,
            "--editors-dir",
            dirtyFixture.editors,
            "--evidence-dir",
            dirtyFixture.evidence,
            "--image-digest",
            `sha256:${"b".repeat(64)}`,
          ],
          dirtyFixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("repository worktree must be clean: helix-workspace");

    const missingFixture = await createFixture();
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [
            "--workspace-dir",
            missingFixture.workspace,
            "--editors-dir",
            missingFixture.editors,
            "--evidence-dir",
            missingFixture.evidence,
            "--require-evidence",
            "restore/report.json",
            "--image-digest",
            `sha256:${"c".repeat(64)}`,
          ],
          missingFixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("required evidence missing: restore/report.json");
  });

  it("requires a valid immutable image digest", async () => {
    const fixture = await createFixture();
    const baseArgs = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
    ];
    await expect(
      buildReleaseReadinessManifest(parseArgs(baseArgs, fixture.root, {})),
    ).rejects.toThrow("--image-digest or HELIX_IMAGE_DIGEST is required");
    await expect(
      buildReleaseReadinessManifest(
        parseArgs([...baseArgs, "--image-digest", "latest"], fixture.root, {}),
      ),
    ).rejects.toThrow("image digest must be an OCI sha256 digest");
  });
});

async function createFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "helix-release-manifest-"));
  const workspace = resolve(root, "helix-workspace");
  const editors = resolve(root, "helix-editors");
  const evidence = resolve(root, "evidence");
  await Promise.all([
    initRepository(workspace, {
      "apps/helix/src/db/migrations/0001_first.sql": "select 1;\n",
      "apps/helix/src/db/migrations/0002_second.sql": "select 2;\n",
    }),
    initRepository(editors, { "README.md": "editors\n" }),
    mkdir(resolve(evidence, "tests"), { recursive: true }),
  ]);
  await writeFile(resolve(evidence, "tests/unit.json"), '{"ok":true}\n', "utf8");
  return { root, workspace, editors, evidence };
}

async function initRepository(directory, files) {
  await mkdir(directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "manifest-test@example.invalid"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "Manifest Test"], { cwd: directory });
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = resolve(directory, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
}
