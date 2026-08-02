import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NegativeMatrixCase {
  readonly domain: string;
  readonly actor: string;
  readonly action: string;
  readonly resource: string;
  readonly expected: string;
}

const REQUIRED_COLUMNS = ["Domain", "Actor", "Action", "Resource", "Expected"] as const;

/**
 * Parse the markdown table in `negative-matrix.md` into structured cases.
 * G1.9 scaffold — domain phases append rows; tests ensure the matrix stays loadable.
 */
export function parseNegativeMatrixMarkdown(markdown: string): readonly NegativeMatrixCase[] {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  if (lines.length < 3) {
    throw new Error(
      "negative-matrix.md must contain a markdown table with header, separator, and rows",
    );
  }

  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new Error("negative-matrix.md missing table header");
  }
  const headerCells = splitRow(headerLine);
  for (const column of REQUIRED_COLUMNS) {
    if (!headerCells.includes(column)) {
      throw new Error(`negative-matrix.md missing required column: ${column}`);
    }
  }

  const domainIdx = headerCells.indexOf("Domain");
  const actorIdx = headerCells.indexOf("Actor");
  const actionIdx = headerCells.indexOf("Action");
  const resourceIdx = headerCells.indexOf("Resource");
  const expectedIdx = headerCells.indexOf("Expected");

  const cases: NegativeMatrixCase[] = [];
  for (const line of lines.slice(2)) {
    const cells = splitRow(line);
    if (cells.every((cell) => cell.length === 0 || /^[-:]+$/.test(cell))) {
      continue;
    }
    const domain = cells[domainIdx] ?? "";
    const actor = cells[actorIdx] ?? "";
    const action = cells[actionIdx] ?? "";
    const resource = cells[resourceIdx] ?? "";
    const expected = cells[expectedIdx] ?? "";
    if ([domain, actor, action, expected].some((value) => value.length === 0)) {
      throw new Error(`negative-matrix.md has an incomplete row: ${line}`);
    }
    cases.push({ domain, actor, action, resource, expected });
  }

  if (cases.length === 0) {
    throw new Error("negative-matrix.md has no data rows");
  }
  return Object.freeze(cases);
}

export function loadNegativeMatrixFromDisk(
  path = join(dirname(fileURLToPath(import.meta.url)), "negative-matrix.md"),
): readonly NegativeMatrixCase[] {
  return parseNegativeMatrixMarkdown(readFileSync(path, "utf8"));
}

/** Domains that must always appear in the scaffold for Full Workspace readiness. */
export const REQUIRED_NEGATIVE_MATRIX_DOMAINS = [
  "mail",
  "drive",
  "chat",
  "agent",
  "origin",
  "scanner",
  "tenant",
] as const;

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
