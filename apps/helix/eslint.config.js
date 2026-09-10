import helixConfig from "@helix/config/eslint";

export default [
  ...helixConfig,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/test-support/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/test-support/**"],
              message: "Production code cannot import test support.",
            },
          ],
        },
      ],
      "helix/pacer-discipline": "off",
    },
  },
];
