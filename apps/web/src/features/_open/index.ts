/* Public entry point for the universal-open feature.
 *
 * Imports from helix-workspace editor routes look like:
 *   import { loadDriveObjectForEditor } from "@/features/_open";
 *   import { UnsupportedFormatPlaceholder } from "@/features/_open/ui";
 */

export { loadDriveObjectForEditor } from "./universal-loader.js";
export type { LoaderResult, LoadOptions } from "./universal-loader.js";
export { detectFormat, UNKNOWN_FORMAT } from "./format-detection.js";
export type { FormatDescriptor, EditorSurface } from "./format-detection.js";
export { fetchDriveBlob, DriveBlobNotFoundError } from "./drive-fetcher.js";
export type { DriveBlob } from "./drive-fetcher.js";
export { getParser } from "./parsers/index.js";
export type {
  FormatParser,
  ParseResult,
  ImportedDoc,
  ImportedSheet,
  ImportedSheetTab,
  ImportedCell,
  ImportedDeck,
  ImportedSlide,
  ImportedPdf,
  ImportedImage,
  UnsupportedFormat,
  TiptapNode,
} from "./parsers/types.js";
