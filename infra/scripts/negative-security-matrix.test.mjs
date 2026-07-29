import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  negativeSecurityCommands,
  V2_NEGATIVE_SECURITY_MATRIX,
  V2_PLAN_PATH,
  validateNegativeSecurityCommandMappings,
  validateNegativeSecurityMatrix,
} from "./negative-security-matrix.mjs";

describe("V2 negative-security requirement index", () => {
  it("maps every plan row and negative case to a concrete automated test", async () => {
    await expect(
      validateNegativeSecurityMatrix(resolve(import.meta.dirname, "../..")),
    ).resolves.toBe(V2_NEGATIVE_SECURITY_MATRIX);
    expect(V2_NEGATIVE_SECURITY_MATRIX.map(({ boundary }) => boundary)).toEqual([
      "Tenant",
      "Mail",
      "Drive",
      "Chat",
      "Agent",
      "AI",
      "Auth",
      "Webhook",
      "Audit",
      "Backup",
    ]);
    expect(V2_NEGATIVE_SECURITY_MATRIX.flatMap((row) => row.cases)).toHaveLength(30);
  });

  it("keeps live Postgres coverage explicit instead of presenting a skipped fixture as default evidence", () => {
    expect(negativeSecurityCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution: "live-postgres",
          requiredEnvironment: ["DATABASE_URL"],
        }),
      ]),
    );
  });

  it("fails closed when a test has no supported execution command", () => {
    const matrix = JSON.parse(JSON.stringify(V2_NEGATIVE_SECURITY_MATRIX));
    matrix[0].cases[0].tests[0].execution = "manual";

    expect(() => validateNegativeSecurityCommandMappings(matrix)).toThrow(
      "uses unsupported execution mode",
    );
  });

  it("fails closed when a case loses every runnable command mapping", () => {
    const matrix = JSON.parse(JSON.stringify(V2_NEGATIVE_SECURITY_MATRIX));
    matrix[0].cases[0].tests = [];

    expect(() => validateNegativeSecurityCommandMappings(matrix)).toThrow(
      "has no runnable command mapping",
    );
  });

  it("fails closed when a referenced test selector disappears", async () => {
    const sourceRoot = resolve(import.meta.dirname, "../..");
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "helix-v2-matrix-"));
    await cp(resolve(sourceRoot, V2_PLAN_PATH), resolve(fixtureRoot, V2_PLAN_PATH), {
      recursive: true,
    });
    for (const test of new Set(
      V2_NEGATIVE_SECURITY_MATRIX.flatMap((row) =>
        row.cases.flatMap((entry) => entry.tests.map(({ file }) => file)),
      ),
    )) {
      const target = resolve(fixtureRoot, test);
      await cp(resolve(sourceRoot, test), target, { recursive: true });
    }
    const targetRef = V2_NEGATIVE_SECURITY_MATRIX[0].cases[0].tests[0];
    const targetPath = resolve(fixtureRoot, targetRef.file);
    const source = await readFile(targetPath, "utf8");
    await writeFile(targetPath, source.replace(targetRef.title, "selector removed"), "utf8");

    await expect(validateNegativeSecurityMatrix(fixtureRoot)).rejects.toThrow(
      "test selector is missing",
    );
  });
});
