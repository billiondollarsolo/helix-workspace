/**
 * helix/no-raw-process-env
 *
 * Forbids `process.env.FOO` / `process.env[name]` outside the validated env
 * module. Passing the whole `process.env` object into injectable config
 * adapters is still allowed (legacy seam) — only property access is reported.
 *
 * Allowlist:
 * - apps/helix/src/config/env.ts (any path ending in /config/env.ts)
 * - test/spec files
 * - seed / verify-demo / migrate scripts under db/
 */

function normalizePath(filename) {
  return filename.replaceAll("\\", "/");
}

function isAllowlisted(filename) {
  const path = normalizePath(filename);

  if (path.endsWith("/config/env.ts") || path.endsWith("/config/env.js")) {
    return true;
  }

  if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u.test(path)) {
    return true;
  }

  // Seed / demo / smoke scripts intentionally read raw env for operator CLIs.
  if (
    /\/db\/(?:seed[^/]*|verify-local-demo|prepare-local-demo|index-local-demo|reseed|fetch-corpus|generate-corpus)\./u.test(
      path,
    )
  ) {
    return true;
  }

  // Migration entrypoints may boot before env() is the universal path.
  if (/\/db\/(?:migrate|migration)[^/]*\./u.test(path)) {
    return true;
  }

  return false;
}

function envKeyLabel(node) {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  if (node.computed) {
    return "[dynamic]";
  }
  return "?";
}

export const noRawProcessEnvRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw process.env property access outside the validated env module",
    },
    messages: {
      noRawProcessEnv:
        "Use env() from config/env.ts instead of process.env.{{key}}. Tests, seeds, and migrate scripts are exempt.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (isAllowlisted(filename)) {
      return {};
    }

    return {
      MemberExpression(node) {
        // Match process.env.FOO / process.env['FOO'] / process.env[name]
        // where the object is the MemberExpression `process.env`.
        const object = node.object;
        if (
          object.type !== "MemberExpression" ||
          object.computed ||
          object.object.type !== "Identifier" ||
          object.object.name !== "process" ||
          object.property.type !== "Identifier" ||
          object.property.name !== "env"
        ) {
          return;
        }

        context.report({
          node,
          messageId: "noRawProcessEnv",
          data: { key: envKeyLabel(node) },
        });
      },
    };
  },
};

export default noRawProcessEnvRule;
