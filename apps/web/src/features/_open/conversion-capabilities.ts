import type { FormatDescriptor } from "./format-detection";
import type { ImportedDeck, ImportedDoc, ImportedSheet } from "./parsers/types";

export type EditableParsedForConversion = ImportedDoc | ImportedSheet | ImportedDeck;

export function canCreateEditableCopyFromFormat(format: FormatDescriptor): boolean {
  if (!format.supported) {
    return false;
  }
  switch (format.surface) {
    case "docs":
      return isDocsFormatWithConverter(format);
    case "sheets":
      return isSheetsFormatWithConverter(format);
    case "slides":
      return isSlidesFormatWithConverter(format);
    default:
      return false;
  }
}

export function canCreateEditableCopy(parsed: EditableParsedForConversion): boolean {
  return canCreateEditableCopyFromFormat(parsed.format);
}

export function editableCopyUnavailableMessage(format: FormatDescriptor): string {
  return `editable conversion for ${format.label} is not available yet. Preview or download the original instead.`;
}

function isDocsFormatWithConverter(format: FormatDescriptor): boolean {
  return (
    format.id === "docx" ||
    format.id === "odt" ||
    format.id === "rtf" ||
    format.id === "txt" ||
    format.id === "md" ||
    format.id === "html" ||
    format.id === "eml"
  );
}

function isSheetsFormatWithConverter(format: FormatDescriptor): boolean {
  return format.id === "xlsx" || format.id === "csv" || format.id === "tsv" || format.id === "ods";
}

function isSlidesFormatWithConverter(format: FormatDescriptor): boolean {
  return format.id === "pptx";
}
