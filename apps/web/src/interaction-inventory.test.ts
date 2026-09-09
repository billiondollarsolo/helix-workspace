import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

describe("production interaction inventory", () => {
  it("contains no inert buttons or placeholder feature claims", () => {
    const failures: string[] = [];
    for (const file of tsxFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<button\b[\s\S]*?<\/button>/gu)) {
        const markup = match[0];
        if (!/onClick=|type="submit"|disabled|\.\.\./u.test(markup)) {
          failures.push(`${relative(sourceRoot, file)}: inert button`);
        }
      }
      if (/not connected|not yet wired|coming soon|will appear here/iu.test(source)) {
        failures.push(`${relative(sourceRoot, file)}: placeholder feature claim`);
      }
    }
    expect(failures).toEqual([]);
  });
});

function tsxFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}
