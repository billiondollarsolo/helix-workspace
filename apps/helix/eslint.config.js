import helixConfig from "@helix/config/eslint";

export default [
  ...helixConfig,
  {
    files: ["src/**/*.ts"],
    rules: {
      "helix/pacer-discipline": "off",
    },
  },
];
