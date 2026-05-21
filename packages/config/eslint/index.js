import js from "@eslint/js";
import process from "node:process";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

function parseDirective(value) {
  const directiveMatch = /\s-{2,}\s/u.exec(value);
  const directivePart = directiveMatch ? value.slice(0, directiveMatch.index).trim() : value.trim();
  const justification = directiveMatch
    ? value.slice(directiveMatch.index + directiveMatch[0].length).trim()
    : "";
  const labelMatch = /^([a-z]+(?:-[a-z]+)*)(?:\s|$)/u.exec(directivePart);

  if (!labelMatch) {
    return undefined;
  }

  return {
    label: labelMatch[1],
    value: directivePart.slice(labelMatch[0].length).trim(),
    justification,
  };
}

function parseListConfig(value) {
  return value
    .split(",")
    .map((name) => name.trim().replace(/^(?<quote>['"]?)(?<ruleId>.*)\k<quote>$/su, "$<ruleId>"))
    .filter(Boolean);
}

const nativePopupRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow browser-native popups and beforeunload guards in Helix browser code",
    },
    messages: {
      nativePopup: "Use an in-app Helix dialog instead of browser-native {{name}}.",
      beforeUnload:
        "Use TanStack Router useBlocker() with an in-app dialog instead of beforeunload.",
    },
    schema: [],
  },
  create(context) {
    const bannedMethods = new Set(["alert", "confirm", "prompt", "open"]);

    function isWindowObject(node) {
      return (
        node && node.type === "Identifier" && (node.name === "window" || node.name === "globalThis")
      );
    }

    function getBannedMemberName(node) {
      if (!node.computed && node.property.type === "Identifier") {
        return bannedMethods.has(node.property.name) ? node.property.name : undefined;
      }

      if (
        node.computed &&
        node.property.type === "Literal" &&
        typeof node.property.value === "string" &&
        bannedMethods.has(node.property.value)
      ) {
        return node.property.value;
      }

      return undefined;
    }

    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && bannedMethods.has(node.callee.name)) {
          context.report({
            node: node.callee,
            messageId: "nativePopup",
            data: { name: node.callee.name },
          });
        }
      },
      MemberExpression(node) {
        const methodName = getBannedMemberName(node);

        if (isWindowObject(node.object) && methodName) {
          context.report({
            node,
            messageId: "nativePopup",
            data: { name: `${node.object.name}.${methodName}` },
          });
        }
      },
      Literal(node) {
        if (node.value === "beforeunload") {
          context.report({ node, messageId: "beforeUnload" });
        }
      },
      TemplateElement(node) {
        if (node.value.raw.includes("beforeunload")) {
          context.report({ node, messageId: "beforeUnload" });
        }
      },
    };
  },
};

const nativePopupDisableRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require justified next-line disables for helix/no-native-popup",
    },
    messages: {
      disableDirective:
        "Use // eslint-disable-next-line helix/no-native-popup -- <justification> for native popup exceptions.",
      disableJustification: "Add a justification after -- when disabling helix/no-native-popup.",
    },
    schema: [],
  },
  create(context) {
    function checkDisableDirective(comment) {
      const directive = parseDirective(comment.value);

      if (!directive || !directive.label.startsWith("eslint-disable")) {
        return;
      }

      const ruleIds = parseListConfig(directive.value);
      const appliesToNativePopup =
        ruleIds.length === 0 || ruleIds.includes("helix/no-native-popup");

      if (!appliesToNativePopup) {
        return;
      }

      if (directive.label !== "eslint-disable-next-line" || ruleIds.length === 0) {
        context.report({ node: comment, messageId: "disableDirective" });
        return;
      }

      if (!directive.justification) {
        context.report({ node: comment, messageId: "disableJustification" });
      }
    }

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          checkDisableDirective(comment);
        }
      },
    };
  },
};

const queryOptionsUseQueryRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require useQuery calls to consume feature queryOptions factories",
    },
    messages: {
      queryOptions:
        "Call useQuery with a feature queryOptions factory instead of an inline query object.",
    },
    schema: [],
  },
  create(context) {
    function isQueryOptionsFactoryCall(node) {
      return (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name.endsWith("QueryOptions")
      );
    }

    function hasQueryOptionsFactorySpread(node) {
      return (
        node.type === "ObjectExpression" &&
        node.properties.some(
          (property) =>
            property.type === "SpreadElement" && isQueryOptionsFactoryCall(property.argument),
        )
      );
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "useQuery") {
          return;
        }

        const [firstArgument] = node.arguments;
        if (
          firstArgument &&
          (isQueryOptionsFactoryCall(firstArgument) || hasQueryOptionsFactorySpread(firstArgument))
        ) {
          return;
        }

        context.report({ node, messageId: "queryOptions" });
      },
    };
  },
};

const mutationDisciplineRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require mutation rollback handlers for TanStack useMutation calls",
    },
    messages: {
      mutationDiscipline:
        "Call useMutation with an object argument that includes both onMutate and onError.",
    },
    schema: [],
  },
  create(context) {
    function getPropertyName(property) {
      if (property.type !== "Property" || property.computed) {
        return undefined;
      }

      if (property.key.type === "Identifier") {
        return property.key.name;
      }

      if (property.key.type === "Literal" && typeof property.key.value === "string") {
        return property.key.value;
      }

      return undefined;
    }

    function hasMutationHandlers(node) {
      if (!node || node.type !== "ObjectExpression") {
        return false;
      }

      const propertyNames = new Set(node.properties.map(getPropertyName).filter(Boolean));
      return propertyNames.has("onMutate") && propertyNames.has("onError");
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "useMutation") {
          return;
        }

        const [firstArgument] = node.arguments;
        if (hasMutationHandlers(firstArgument)) {
          return;
        }

        context.report({ node, messageId: "mutationDiscipline" });
      },
    };
  },
};

const queryRefreshDisciplineRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require query invalidation helpers instead of direct TanStack query refetches",
    },
    messages: {
      queryRefreshDiscipline: "Use a query invalidation helper instead of direct refetch calls.",
    },
    schema: [],
  },
  create(context) {
    function isRefetchMember(node) {
      if (!node.computed && node.property.type === "Identifier") {
        return node.property.name === "refetch";
      }

      return (
        node.computed &&
        node.property.type === "Literal" &&
        node.property.value === "refetch"
      );
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression" || !isRefetchMember(node.callee)) {
          return;
        }

        context.report({ node: node.callee, messageId: "queryRefreshDiscipline" });
      },
    };
  },
};

const pacerDisciplineRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require TanStack Pacer hooks instead of native browser timers",
    },
    messages: {
      pacerDiscipline: "Use TanStack Pacer hooks instead of native {{name}}.",
    },
    schema: [],
  },
  create(context) {
    const bannedTimerMethods = new Set([
      "clearInterval",
      "clearTimeout",
      "setInterval",
      "setTimeout",
    ]);

    function isBrowserGlobal(node) {
      return (
        node && node.type === "Identifier" && (node.name === "window" || node.name === "globalThis")
      );
    }

    function getBannedMemberName(node) {
      if (!node.computed && node.property.type === "Identifier") {
        return bannedTimerMethods.has(node.property.name) ? node.property.name : undefined;
      }

      if (
        node.computed &&
        node.property.type === "Literal" &&
        typeof node.property.value === "string" &&
        bannedTimerMethods.has(node.property.value)
      ) {
        return node.property.value;
      }

      return undefined;
    }

    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && bannedTimerMethods.has(node.callee.name)) {
          context.report({
            node: node.callee,
            messageId: "pacerDiscipline",
            data: { name: node.callee.name },
          });
          return;
        }

        if (node.callee.type !== "MemberExpression" || !isBrowserGlobal(node.callee.object)) {
          return;
        }

        const methodName = getBannedMemberName(node.callee);
        if (methodName) {
          context.report({
            node: node.callee,
            messageId: "pacerDiscipline",
            data: { name: `${node.callee.object.name}.${methodName}` },
          });
        }
      },
    };
  },
};

const internalAnchorRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require TanStack Router Link for internal app navigation",
    },
    messages: {
      internalAnchor: "Use TanStack Router <Link> instead of a raw <a href> for internal routes.",
    },
    schema: [],
  },
  create(context) {
    function isInternalHref(value) {
      return typeof value === "string" && (value.startsWith("/") || value.startsWith("./"));
    }

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "a") {
          return;
        }

        const hrefAttribute = node.attributes.find(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "href",
        );
        if (!hrefAttribute || !hrefAttribute.value) {
          return;
        }

        if (hrefAttribute.value.type === "Literal" && isInternalHref(hrefAttribute.value.value)) {
          context.report({ node: hrefAttribute, messageId: "internalAnchor" });
        }
      },
    };
  },
};

export const helixBrowserPlugin = {
  rules: {
    "internal-link": internalAnchorRule,
    "mutation-discipline": mutationDisciplineRule,
    "no-native-popup": nativePopupRule,
    "native-popup-disable": nativePopupDisableRule,
    "pacer-discipline": pacerDisciplineRule,
    "query-refresh-discipline": queryRefreshDisciplineRule,
    "use-query-options": queryOptionsUseQueryRule,
  },
};

export const helixBrowserRules = {
  "helix/internal-link": "error",
  "helix/mutation-discipline": "error",
  "helix/no-native-popup": "error",
  "helix/native-popup-disable": "error",
  "helix/pacer-discipline": "error",
  "helix/query-refresh-discipline": "error",
  "helix/use-query-options": "error",
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: ["dist/**", "node_modules/**", ".tanstack/**", "coverage/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      helix: helixBrowserPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...helixBrowserRules,
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/tests/**/*.ts",
      "**/tests/**/*.tsx",
    ],
    rules: {
      "helix/pacer-discipline": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
