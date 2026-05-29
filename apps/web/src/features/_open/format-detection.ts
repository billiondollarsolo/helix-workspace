/* Re-export from the SDK package.
 *
 * Format detection moved into @helix/editors-format-loader (Task #20) so the
 * helix-editors SDK can be embedded by other products with the full format
 * pipeline. This local module stays as a shim so the rest of apps/web keeps
 * importing from `@/features/_open/format-detection` unchanged.
 */
export { detectFormat, UNKNOWN_FORMAT } from "@helix/editors-format-loader";
export type { EditorSurface, FormatDescriptor } from "@helix/editors-format-loader";
