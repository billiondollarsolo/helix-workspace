import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { helixBrowserPlugin } from "./index.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("helix/no-raw-process-env", () => {
  it("forbids process.env property access outside allowlisted files", () => {
    ruleTester.run("no-raw-process-env", helixBrowserPlugin.rules["no-raw-process-env"], {
      valid: [
        {
          code: "const x = process.env.FOO;",
          filename: "/repo/apps/helix/src/config/env.ts",
        },
        {
          code: "const x = process.env.FOO;",
          filename: "/repo/apps/helix/src/server.test.ts",
        },
        {
          code: "const x = process.env.FOO;",
          filename: "/repo/apps/web/tests/e2e/support/backend-mode.ts",
        },
        {
          code: "const x = process.env.FOO;",
          filename: "/repo/apps/helix/src/db/seed-local-demo.ts",
        },
        {
          code: "const x = process.env.FOO;",
          filename: "/repo/apps/helix/src/db/migrate.ts",
        },
        // Whole-object injection is allowed (legacy adapters).
        {
          code: "loadConfig(process.env);",
          filename: "/repo/apps/helix/src/server.ts",
        },
        {
          code: "const x = env().FOO;",
          filename: "/repo/apps/helix/src/server.ts",
        },
      ],
      invalid: [
        {
          code: "const x = process.env.FOO;",
          filename: "/repo/apps/helix/src/server.ts",
          errors: [{ messageId: "noRawProcessEnv" }],
        },
        {
          code: "const x = process.env['FOO'];",
          filename: "/repo/apps/helix/src/platform/mail/providers.ts",
          errors: [{ messageId: "noRawProcessEnv" }],
        },
        {
          code: "const x = process.env[name];",
          filename: "/repo/apps/helix/src/server.ts",
          errors: [{ messageId: "noRawProcessEnv" }],
        },
      ],
    });
  });
});
