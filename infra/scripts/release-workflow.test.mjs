import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("executes the release tag gate: annotated RC only, matching commit, and signed GA", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const imageWorkflow = readFileSync(".github/workflows/production-image-security.yml", "utf8");
  for (const [candidate, subject] of [
    ["app", "APPLICATION"],
    ["web", "WEB"],
  ]) {
    const registry = new RegExp(
      `candidate: ${candidate}\\n[\\s\\S]*?registry_name: ([\\w-]+)`,
      "u",
    ).exec(imageWorkflow)?.[1];
    expect(registry).toBeDefined();
    expect(workflow).toContain(
      `HELIX_RELEASE_TRUSTED_${subject}_SUBJECT: ghcr.io/` +
        "${{ github.repository_owner }}/" +
        registry,
    );
  }
  const script = workflow
    .split("        run: |\n")[1]
    .split("\n  build-images-and-sboms:")[0]
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
  const directory = mkdtempSync(join(tmpdir(), "helix-release-tag-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  try {
    git("init", "--quiet");
    git("config", "user.name", "Release gate fixture");
    git("config", "user.email", "release-fixture@example.test");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture");
    const sha = git("rev-parse", "HEAD").trim();
    git("-c", "tag.gpgsign=false", "tag", "-a", "v1.0.0-rc.1", "-m", "candidate");
    git("-c", "tag.gpgsign=false", "tag", "v1.0.0-rc.2");
    git("-c", "tag.gpgsign=false", "tag", "-a", "v1.0.0", "-m", "unsigned final");
    const run = (tag, commit = sha) =>
      spawnSync("bash", ["-c", script], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_REF: `refs/tags/${tag}`,
          GITHUB_REF_NAME: tag,
          GITHUB_SHA: commit,
          TAG_SIGNER_FINGERPRINT: "A".repeat(40),
          TAG_PUBLIC_KEY: "",
          RUNNER_TEMP: directory,
        },
      }).status;
    expect(run("v1.0.0-rc.1")).toBe(0);
    expect(run("v1.0.0-rc.1", "0".repeat(40))).not.toBe(0);
    expect(run("v1.0.0-rc.2")).not.toBe(0);
    expect(run("v1.0.0-rc.0")).not.toBe(0);
    expect(run("v1.0.0")).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
