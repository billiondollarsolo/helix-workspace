import js from "@eslint/js";
import { helixBrowserPlugin, helixBrowserRules } from "@helix/config/eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      helix: helixBrowserPlugin
    },
    rules: {
      ...helixBrowserRules
    }
  }
);
