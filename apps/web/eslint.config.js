import js from "@eslint/js";
import { helixBrowserPlugin, helixBrowserRules } from "@helix/config/eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
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
    rules: {
      "helix/pacer-discipline": "off",
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
