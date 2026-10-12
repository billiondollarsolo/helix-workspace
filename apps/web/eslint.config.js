import js from "@eslint/js";
import {
  fileSizeConfigs,
  helixBrowserPlugin,
  helixBrowserRules,
  helixTestRules,
} from "@helix/config/eslint";
import tseslint from "typescript-eslint";
import { helixWebPlugin } from "./eslint-rules/design-tokens.js";
import { remountRules } from "./eslint-rules/react-remounts.js";

export default tseslint.config(
  ...fileSizeConfigs,
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: ["src/routeTree.gen.ts"],
  },
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      helix: helixBrowserPlugin,
      "helix-web": { ...helixWebPlugin, rules: { ...helixWebPlugin.rules, ...remountRules } },
    },
    rules: {
      ...helixBrowserRules,
      "helix-web/design-tokens": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "crypto",
          property: "randomUUID",
          message:
            "Use randomId() from @/lib/random-id: crypto.randomUUID is missing outside secure contexts (plain HTTP on a LAN).",
        },
      ],
      // Typing must never lose focus: no per-render component types, no keys
      // derived from values the row edits.
      "helix-web/no-nested-components": "error",
      "helix-web/no-editable-key": "error",
      // Measured geometry, transforms, and values from user data stay inline.
      // Static declarations belong in the token-backed stylesheet or utilities.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property[value.type='Literal']",
          message:
            "Use CSS tokens or utility classes for static styles; reserve style for dynamic values.",
        },
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property[value.type='TemplateLiteral'][value.expressions.length=0]",
          message:
            "Use CSS tokens or utility classes for static styles; reserve style for dynamic values.",
        },
      ],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "tests/**/*.ts",
      "tests/**/*.tsx",
      "src/test/**/*.ts",
      "src/test/**/*.tsx",
    ],
    rules: {
      ...helixTestRules,
      "helix-web/design-tokens": "off",
      // Test harnesses declared inside a test body render once per test.
      "helix-web/no-nested-components": "off",
    },
  },
  {
    // Playwright E2E specs live outside the app tsconfig's `include`. Point the
    // type-checked parser at the dedicated `tests/e2e/tsconfig.json` so
    // `eslint tests` can lint them (see the `lint:e2e` package script).
    files: ["tests/e2e/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tests/e2e/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
