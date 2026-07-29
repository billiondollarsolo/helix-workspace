const mvpExcludedSurfaceNames = ["calendar", "docs", "sheets", "slides", "meet", "pdf"] as const;

/**
 * TanStack applies this expression to each route directory entry. Ignoring
 * the surface directory prevents its route from entering the generated tree
 * in the first place, so auto-code-splitting cannot make an editor chunk.
 */
export const MVP_ROUTE_FILE_IGNORE_PATTERN = `^(?:${mvpExcludedSurfaceNames.join("|")})$`;

const mvpForbiddenModulePatterns: readonly {
  readonly pattern: RegExp;
  readonly description: string;
}[] = [
  {
    pattern: /\/src\/routes\/_shell\/(?:calendar|docs|sheets|slides|meet|pdf)\//,
    description: "excluded workspace route",
  },
  {
    pattern: /\/src\/features\/(?:calendar|docs|sheets|slides|meet|pdf)\//,
    description: "excluded workspace feature",
  },
  {
    pattern: /\/src\/features\/_open\/converters\.[cm]?[jt]sx?(?:\?|$)/,
    description: "native editor conversion module",
  },
  {
    pattern: /\/node_modules\/@helix\/editors-ui\//,
    description: "native editor UI package",
  },
  {
    pattern:
      /\/node_modules\/(?:@tiptap\/extension-collaboration(?:-caret)?|yjs|y-protocols|lib0)\//,
    description: "native document collaboration dependency",
  },
  {
    pattern: /\/node_modules\/(?:pdf-lib|@pdf-lib\/[^/]+)\//,
    description: "PDF editing dependency",
  },
];

export function isMvpOnlyBuild(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Return a diagnostic for modules that must never be reachable from the
 * production MVP entry graph. Paths are normalized because Rollup module IDs
 * use platform-specific separators and can carry a Vite query suffix.
 */
export function mvpBundleBoundaryViolation(moduleId: string): string | null {
  const normalizedId = moduleId.replaceAll("\\", "/");
  const boundary = mvpForbiddenModulePatterns.find(({ pattern }) => pattern.test(normalizedId));
  return boundary === undefined ? null : `${boundary.description}: ${normalizedId}`;
}
