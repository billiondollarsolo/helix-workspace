import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RELEASE_EVIDENCE_BINDING_SCHEMA } from "./release-evidence-binding.mjs";

const execFileAsync = promisify(execFile);
const bindingEnvironment = {
  HELIX_RELEASE_WORKSPACE_SHA: "a".repeat(40),
  HELIX_RELEASE_EDITORS_SHA: "d".repeat(40),
  HELIX_RELEASE_APPLICATION_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  HELIX_RELEASE_WEB_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
};

const staticRunners = [
  ["Mail", "infra/scripts/mail-live-evidence-smoke.mjs", "--static"],
  ["Drive", "infra/scripts/drive-live-evidence-smoke.mjs"],
  ["Chat", "infra/scripts/chat-live-evidence-smoke.mjs"],
  ["Agent", "infra/scripts/agent-live-evidence-smoke.mjs", "--static"],
  ["data-plane", "infra/scripts/data-plane-live-evidence.mjs", "--static"],
  ["restore", "infra/scripts/restore-drill-evidence.mjs", "--static"],
  ["failure/recovery", "infra/scripts/failure-recovery-runner.mjs", "--static"],
];

describe("release evidence runner binding integration", () => {
  it.each(staticRunners)(
    "%s CLI embeds the complete canonical binding",
    async (_, path, ...args) => {
      const { stdout } = await execFileAsync(process.execPath, [path, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...bindingEnvironment },
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(JSON.parse(stdout).releaseBinding).toEqual({
        schema: RELEASE_EVIDENCE_BINDING_SCHEMA,
        workspaceSha: bindingEnvironment.HELIX_RELEASE_WORKSPACE_SHA,
        editorsSha: bindingEnvironment.HELIX_RELEASE_EDITORS_SHA,
        applicationImageDigest: bindingEnvironment.HELIX_RELEASE_APPLICATION_IMAGE_DIGEST,
        webImageDigest: bindingEnvironment.HELIX_RELEASE_WEB_IMAGE_DIGEST,
      });
    },
  );
});
