#!/usr/bin/env node
import ts from "typescript";
import { join } from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const homes = {
  toSqlJson: ["platform/util/sql.ts"],
  isUniqueViolation: ["platform/util/sql.ts"],
  isRecord: [],
  isJsonObject: [],
  isJsonValue: [],
  defineTool: ["platform/tools/define-tool.ts"],
  errorMessage: ["platform/util/errors.ts"],
  compactJsonObject: ["platform/util/json.ts"],
  hasControlCharacter: ["platform/util/strings.ts"],
  parseBasicAuthorization: ["platform/util/http-auth.ts"],
};
function duplicates(file, source) {
  if (!file.startsWith("apps/helix/src/") || /\.(?:test|spec)\.|\/test-support\//u.test(file))
    return [];
  const failures = [];
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        (ts.isVariableDeclaration(node) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      const name = node.name.text;
      if (
        Object.hasOwn(homes, name) &&
        !homes[name].some((home) => file === `apps/helix/src/${home}`)
      )
        failures.push(`${file}: import ${name} from its shared home`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return failures;
}
function baselineGrowth(current, previous) {
  return Object.entries(current)
    .filter(([file, count]) => previous[file] === undefined || count > previous[file])
    .map(([file]) => `${file}: file-size baseline cannot grow`);
}
function lines(source) {
  return source.split(/\r\n|\r|\n/u).length - Number(/(?:\r|\n)$/u.test(source));
}
if (process.argv.includes("--self-test")) {
  assert.equal(
    duplicates("apps/helix/src/platform/mail/example.ts", "function toSqlJson() {}").length,
    1,
  );
  assert.equal(
    duplicates("apps/helix/src/platform/util/sql.ts", "function toSqlJson() {}").length,
    0,
  );
  assert.equal(
    duplicates("apps/helix/src/example.test.ts", "const isRecord = () => true").length,
    0,
  );
  assert.deepEqual(baselineGrowth({ a: 801 }, { a: 802 }), []);
  assert.equal(baselineGrowth({ a: 803 }, { a: 802 }).length, 1);
  assert.equal(baselineGrowth({ b: 801 }, { a: 802 }).length, 1);
  assert.equal(lines("a\nb\n"), 2);
  console.log("Source structure regression checks passed.");
  process.exit(0);
}
const baseline = JSON.parse(
  readFileSync(new URL("../../.file-size-baseline.json", import.meta.url), "utf8"),
);
const failures = [];
const checkSize = process.argv.includes("--size");
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
).split("\0");
for (const file of new Set(files)) {
  if (
    !/^(apps|packages)\/.*\.(?:ts|tsx|js|mjs|cjs)$/u.test(file) ||
    file.endsWith("routeTree.gen.ts") ||
    !existsSync(join(root, file))
  )
    continue;
  const source = readFileSync(join(root, file), "utf8");
  if (!checkSize) failures.push(...duplicates(file, source));
  else if (lines(source) > (baseline[file] ?? 800))
    failures.push(`${file}: ${lines(source)} lines exceeds ${baseline[file] ?? 800}`);
}
if (checkSize) {
  const base = process.argv[process.argv.indexOf("--base") + 1];
  if (process.argv.includes("--base") && base && !/^0+$/u.test(base)) {
    assert.match(base, /^[a-f0-9]{7,40}$/u, "Base must be a Git SHA");
    // The first adoption has no baseline in the parent. Later changes must only shrink it.
    const listing = execFileSync(
      "git",
      ["ls-tree", "--name-only", base, ".file-size-baseline.json"],
      { cwd: root, encoding: "utf8" },
    );
    if (listing.trim())
      failures.push(
        ...baselineGrowth(
          baseline,
          JSON.parse(
            execFileSync("git", ["show", `${base}:.file-size-baseline.json`], {
              cwd: root,
              encoding: "utf8",
            }),
          ),
        ),
      );
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(checkSize ? "File size limits passed." : "Shared helper boundaries passed.");
