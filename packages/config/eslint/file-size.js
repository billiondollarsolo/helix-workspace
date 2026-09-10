import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = JSON.parse(
  readFileSync(new URL("../../../.file-size-baseline.json", import.meta.url), "utf8"),
);

// Existing large files get their current ceiling; the source gate only permits decreases.
export const fileSizeConfigs = [
  { files: ["**/*.{ts,tsx,js,mjs,cjs}"], rules: { "max-lines": ["error", 800] } },
  ...Object.entries(baseline).map(([file, lines]) => ({
    basePath: root,
    files: [file],
    rules: { "max-lines": ["error", lines] },
  })),
];
