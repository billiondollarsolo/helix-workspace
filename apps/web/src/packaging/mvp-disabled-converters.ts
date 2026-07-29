import type { ImportedDeck, ImportedDoc, ImportedSheet } from "@/features/_open/parsers/types";

export interface ConvertedTarget {
  readonly surface: "docs" | "sheets" | "slides";
  readonly id: string;
}

/**
 * Production resolves the native conversion import to this fail-closed stub.
 * It keeps the read-only `/open` route usable without making editor mutation
 * APIs reachable from the bundle.
 */
export function convertImportedDocToNative(
  blob: Blob,
  parsed: ImportedDoc,
  sourceObjectId?: string,
): Promise<ConvertedTarget> {
  return nativeConversionDisabled(blob, parsed, sourceObjectId);
}

export function convertImportedSheetToNative(
  blob: Blob,
  parsed: ImportedSheet,
  sourceObjectId?: string,
): Promise<ConvertedTarget> {
  return nativeConversionDisabled(blob, parsed, sourceObjectId);
}

export function convertImportedDeckToNative(
  blob: Blob,
  parsed: ImportedDeck,
  sourceObjectId?: string,
): Promise<ConvertedTarget> {
  return nativeConversionDisabled(blob, parsed, sourceObjectId);
}

function nativeConversionDisabled(...input: readonly unknown[]): Promise<never> {
  void input;
  return Promise.reject(
    new Error("Native editor conversion is unavailable in the production MVP build."),
  );
}
