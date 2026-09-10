import { expect, it } from "vitest";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.js";

const rule = config.find((entry) => entry.rules?.["no-restricted-syntax"]).rules[
  "no-restricted-syntax"
];

it("requires classes for static declarations while allowing measured and data styles", () => {
  const linter = new Linter();
  const check = (source) =>
    linter.verify(source, {
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { "no-restricted-syntax": rule },
    });
  expect(check('const node = <div style={{ display: "flex", height }} />;')).toHaveLength(1);
  expect(check("const node = <div style={{ display: `flex` }} />;")).toHaveLength(1);
  expect(
    check(
      "const node = <div style={{ height, color: label.color, transform: `translateY(${offset}px)` }} />;",
    ),
  ).toEqual([]);
});
