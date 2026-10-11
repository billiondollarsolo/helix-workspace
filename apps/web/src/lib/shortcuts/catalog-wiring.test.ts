import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHORTCUT_CATALOG, type ShortcutId } from "./catalog";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file))
    .filter((file) => !file.endsWith(path.join("shortcuts", "catalog.ts")))
    .map((file) => readFileSync(path.join(srcRoot, file), "utf8"));
}

describe("shortcut catalog", () => {
  it("lists only shortcuts that some component binds with useShortcuts", () => {
    const sources = sourceFiles().join("\n");
    const unbound = (Object.keys(SHORTCUT_CATALOG) as ShortcutId[]).filter(
      (id) => !sources.includes(`"${id}":`),
    );
    expect(unbound).toEqual([]);
  });
});
