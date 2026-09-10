import js from "@eslint/js";
import {
  fileSizeConfigs,
  helixBrowserPlugin,
  helixBrowserRules,
  helixTestRules,
} from "@helix/config/eslint";
import tseslint from "typescript-eslint";

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
    },
    rules: {
      ...helixBrowserRules,
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
    ],
    rules: helixTestRules,
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
