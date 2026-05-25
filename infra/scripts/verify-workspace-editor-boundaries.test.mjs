import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(new URL("../..", import.meta.url).pathname);
const verifier = join(workspaceRoot, "infra/scripts/verify-workspace-editor-boundaries.mjs");

describe("verify-workspace-editor-boundaries", () => {
  it("allows the published editors core-app package contract", async () => {
    const root = await fixtureWorkspace({
      "apps/helix/src/editors.ts": [
        'import("@helix/editors-core-app");',
        "export const ok = true;",
      ].join("\n"),
      "package.json": JSON.stringify({
        dependencies: {
          "@helix/editors-core-app": "workspace:*",
        },
      }),
    });

    const result = runVerifier(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects raw string literals that point into the sibling package tree", async () => {
    const forbiddenPath = ["helix-editors", "packages", "core-app", "dist", "index.js"].join("/");
    const root = await fixtureWorkspace({
      "apps/helix/src/bad.ts": [
        `const entry = ${JSON.stringify(`/repo/${forbiddenPath}`)};`,
        "export { entry };",
      ].join("\n"),
    });

    const result = runVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("editor-boundary violations");
    expect(result.stderr).toContain("bad.ts references");
    expect(result.stderr).toContain("string literal crosses into");
  });

  it("rejects bundled plugin source imports from editor internals", async () => {
    const forbiddenPackage = "@helix/" + "editors-document";
    const root = await fixtureWorkspace({
      "plugins/com.helix.example/index.js": [
        `import { createDocumentEditor } from ${JSON.stringify(forbiddenPackage)};`,
        "export { createDocumentEditor };",
      ].join("\n"),
    });

    const result = runVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugins/com.helix.example/index.js references");
    expect(result.stderr).toContain("direct dependency on editor package internals");
  });

  it("rejects editor internals in package manifests outside apps and packages", async () => {
    const forbiddenPackage = "@helix/" + "editors-engine-ooxml";
    const root = await fixtureWorkspace({
      "plugins/com.helix.example/package.json": JSON.stringify({
        dependencies: {
          [forbiddenPackage]: "workspace:*",
        },
      }),
    });

    const result = runVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugins/com.helix.example/package.json references");
    expect(result.stderr).toContain("dependencies.@helix/editors-engine-ooxml");
  });
});

async function fixtureWorkspace(files) {
  const root = await mkdtemp(join(tmpdir(), "helix-boundary-"));
  for (const directory of ["apps/helix/src", "packages", "plugins", "infra/scripts"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(resolve(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

function runVerifier(root) {
  return spawnSync(process.execPath, [verifier], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HELIX_WORKSPACE_DIR: root,
      HELIX_EDITORS_DIR: "/repo/helix-editors",
    },
    encoding: "utf8",
  });
}
