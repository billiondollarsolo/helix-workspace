/**
 * helix/no-cross-domain-import
 *
 * Within apps/helix/src/platform/<domain>/*, forbid relative imports of
 * another domain's internal store module (…/otherDomain/store or
 * …/otherDomain/store.js). Public barrels (…/otherDomain or …/otherDomain/index)
 * remain allowed.
 *
 * Files outside platform/<domain>/ are not checked (composition roots like
 * server.ts may wire stores freely).
 */

const PLATFORM_SEGMENT = "/platform/";
const INTERNAL_STORE = /(?:^|\/)store(?:\.js|\.ts)?$/u;
const BARREL_INDEX = /(?:^|\/)index(?:\.js|\.ts)?$/u;

function normalizePath(filename) {
  return filename.replaceAll("\\", "/");
}

/**
 * @returns {{ domain: string, platformRoot: string } | undefined}
 */
function platformDomainOf(filename) {
  const path = normalizePath(filename);
  const idx = path.lastIndexOf(PLATFORM_SEGMENT);
  if (idx === -1) {
    return undefined;
  }
  const after = path.slice(idx + PLATFORM_SEGMENT.length);
  const domain = after.split("/")[0];
  if (!domain || domain.includes(".")) {
    // platform/foo.ts (file at platform root) — not a domain folder
    return undefined;
  }
  return {
    domain,
    platformRoot: path.slice(0, idx + PLATFORM_SEGMENT.length),
  };
}

/**
 * Resolve a relative import source against the importing file's directory.
 * Returns a normalized absolute-ish path string (no real FS access).
 */
function resolveRelativeImport(importerFile, source) {
  if (!source.startsWith(".")) {
    return undefined;
  }
  const path = normalizePath(importerFile);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const parts = dir.split("/").filter(Boolean);
  for (const segment of source.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/**
 * If resolved path is under platform/<domain>/… return domain + rest.
 */
function platformTargetOf(resolvedPath) {
  const path = normalizePath(resolvedPath);
  const idx = path.lastIndexOf(PLATFORM_SEGMENT);
  if (idx === -1) {
    // Also handle paths that start with platform/ after synthetic resolve
    const alt = path.indexOf("/platform/");
    if (alt === -1) {
      return undefined;
    }
  }
  const marker = path.includes(PLATFORM_SEGMENT)
    ? path.slice(path.lastIndexOf(PLATFORM_SEGMENT) + PLATFORM_SEGMENT.length)
    : undefined;
  if (!marker) {
    return undefined;
  }
  const [domain, ...rest] = marker.split("/");
  if (!domain) {
    return undefined;
  }
  return { domain, rest: rest.join("/") };
}

function isInternalStorePath(rest) {
  if (!rest) {
    return false;
  }
  // Bare domain barrel or index is public surface.
  if (rest === "" || BARREL_INDEX.test(rest)) {
    return false;
  }
  // store, store.js, store/foo — internal
  return INTERNAL_STORE.test(rest) || rest === "store" || rest.startsWith("store/");
}

export const noCrossDomainImportRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid platform/<domain> from importing another domain's internal store modules",
    },
    messages: {
      crossDomainStore:
        "Do not import platform/{{fromDomain}} internal store from platform/{{toDomain}}. Use the domain barrel (platform/{{fromDomain}}) or a shared seam.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const current = platformDomainOf(filename);
    if (!current) {
      return {};
    }

    function checkSource(node, source) {
      if (typeof source !== "string") {
        return;
      }
      const resolved = resolveRelativeImport(filename, source);
      if (!resolved) {
        return;
      }
      const target = platformTargetOf(resolved);
      if (!target || target.domain === current.domain) {
        return;
      }
      if (!isInternalStorePath(target.rest)) {
        return;
      }
      context.report({
        node,
        messageId: "crossDomainStore",
        data: {
          fromDomain: target.domain,
          toDomain: current.domain,
        },
      });
    }

    return {
      ImportDeclaration(node) {
        if (node.source.type === "Literal") {
          checkSource(node.source, node.source.value);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && node.source.type === "Literal") {
          checkSource(node.source, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        if (node.source && node.source.type === "Literal") {
          checkSource(node.source, node.source.value);
        }
      },
      CallExpression(node) {
        // import("...")
        if (node.callee.type !== "Import" || node.arguments.length === 0) {
          return;
        }
        const [arg] = node.arguments;
        if (arg && arg.type === "Literal" && typeof arg.value === "string") {
          checkSource(arg, arg.value);
        }
      },
    };
  },
};

export default noCrossDomainImportRule;
