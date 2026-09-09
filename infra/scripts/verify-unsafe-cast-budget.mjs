#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const errors = [];
const platform = join(root, "apps/helix/src/platform");
for (const entry of await readdir(platform, { withFileTypes: true })) {
  const matches = entry.isDirectory()
    ? await countDoubleCasts(join(platform, entry.name))
    : await countSourceDoubleCasts(join(platform, entry.name));
  if (matches > 0) errors.push(`${entry.name}: ${matches} unchecked double casts`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Unsafe double-cast gate passed.");
}

async function countDoubleCasts(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countDoubleCasts(file);
    } else count += await countSourceDoubleCasts(file);
  }
  return count;
}

async function countSourceDoubleCasts(file) {
  if (![".ts", ".tsx"].includes(extname(file)) || /\.(?:test|spec)\.tsx?$/u.test(file)) return 0;
  const source = await readFile(file, "utf8");
  return source.match(/\bas\s+unknown\s+as\b/gu)?.length ?? 0;
}
