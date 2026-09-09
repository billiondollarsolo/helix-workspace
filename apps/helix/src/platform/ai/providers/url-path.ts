/**
 * Joins URL path segments into a single absolute path, collapsing embedded and
 * duplicate slashes. Shared by the cloud providers (Bedrock, Vertex) that build
 * an invoke URL by appending to a configurable endpoint's own base path.
 *
 * Intentionally not re-exported from `providers/index.ts` — this is an internal
 * helper, not part of the platform AI surface.
 */
export function joinPaths(...parts: readonly string[]): string {
  return `/${parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0)
    .join("/")}`;
}
