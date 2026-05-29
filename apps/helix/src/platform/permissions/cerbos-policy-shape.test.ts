import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { SCOPE_CATALOG } from "./scope-catalog.js";

interface CerbosRule {
  readonly actions?: readonly string[];
  readonly roles?: readonly string[];
  readonly condition?: {
    readonly match?: {
      readonly expr?: string;
    };
  };
}

interface CerbosResourcePolicyFile {
  readonly resourcePolicy?: {
    readonly rules?: readonly CerbosRule[];
  };
}

const policyPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../infra/cerbos/policies/tool.yaml",
);

function readToolPolicy(): CerbosResourcePolicyFile {
  return YAML.parse(readFileSync(policyPath, "utf8")) as CerbosResourcePolicyFile;
}

describe("Cerbos tool policy shape", () => {
  it("uses action-specific scoped rules for every non-composite tool scope", () => {
    const rules = readToolPolicy().resourcePolicy?.rules ?? [];
    const scopedRules = rules.filter((rule) =>
      rule.roles?.some((role) => role === "user" || role === "agent" || role === "service_account"),
    );
    const expectedScopes = SCOPE_CATALOG.filter(
      (scope) => scope.composite !== true && scope.protocolScope !== true,
    ).map((scope) => scope.scope);

    expect(scopedRules.every((rule) => !rule.actions?.includes("*"))).toBe(true);
    expect(scopedRules.map((rule) => rule.actions?.[0]).sort()).toEqual([...expectedScopes].sort());

    for (const scope of expectedScopes) {
      const rule = scopedRules.find((candidate) => candidate.actions?.[0] === scope);
      expect(rule?.condition?.match?.expr).toContain(`R.attr.permission == "${scope}"`);
      expect(rule?.condition?.match?.expr).toContain(`scope == "${scope}"`);
      expect(rule?.condition?.match?.expr).toContain("P.attr.org_id == R.attr.org_id");
    }
  });
});
