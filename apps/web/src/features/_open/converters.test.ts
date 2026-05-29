// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertImportedDeckToNative,
  convertImportedDocToNative,
  convertImportedSheetToNative,
} from "./converters";
import type { DriveBlob } from "./drive-fetcher";
import type { ImportedDeck, ImportedDoc, ImportedSheet } from "./parsers/types";

const importDocxDocumentMock = vi.fn();
const createDocsDocumentMock = vi.fn();
const migrateDocsDocumentToNativeMock = vi.fn();
const importXlsxSheetMock = vi.fn();
const importOdsSheetMock = vi.fn();
const importPptxDeckMock = vi.fn();

vi.mock("@/features/docs/api", () => ({
  importDocxDocument: (...args: unknown[]) => importDocxDocumentMock(...args),
  createDocsDocument: (...args: unknown[]) => createDocsDocumentMock(...args),
  migrateDocsDocumentToNative: (...args: unknown[]) => migrateDocsDocumentToNativeMock(...args),
}));

vi.mock("@/features/sheets/api", () => ({
  importCsvSheet: vi.fn(),
  importOdsSheet: (...args: unknown[]) => importOdsSheetMock(...args),
  importTsvSheet: vi.fn(),
  importXlsxSheet: (...args: unknown[]) => importXlsxSheetMock(...args),
}));

vi.mock("@/features/slides/api", () => ({
  importPptxDeck: (...args: unknown[]) => importPptxDeckMock(...args),
}));

describe("converters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importDocxDocumentMock.mockResolvedValue({ id: "doc-docx" });
    createDocsDocumentMock.mockResolvedValue({ id: "doc-created" });
    migrateDocsDocumentToNativeMock.mockResolvedValue(undefined);
    importOdsSheetMock.mockResolvedValue({ id: "sheet-ods" });
    importXlsxSheetMock.mockResolvedValue({ id: "sheet-xlsx" });
    importPptxDeckMock.mockResolvedValue({ id: "deck-pptx" });
  });

  it("preserves DOCX-family document extensions in provenance metadata", async () => {
    const blob: DriveBlob = {
      name: "Macro Template.dotm",
      mimeType: "application/vnd.ms-word.template.macroEnabled.12",
      bytes: new TextEncoder().encode("dotm").buffer,
      byteLength: 4,
    };
    const parsed: ImportedDoc = {
      kind: "doc",
      format: {
        id: "docx",
        label: "DOTM (Macro-enabled Word template)",
        surface: "docs",
        supported: true,
      },
      tiptapDoc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Macro template" }] }],
      },
      warnings: [],
    };

    await expect(convertImportedDocToNative(blob, parsed, "drive-dotm")).resolves.toEqual({
      surface: "docs",
      id: "doc-docx",
    });
    expect(importDocxDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Macro Template.dotm",
        title: "Macro Template",
        contentBase64: "ZG90bQ==",
        metadata: expect.objectContaining({
          importedFromDriveObjectId: "drive-dotm",
          importedFromFilename: "Macro Template.dotm",
          importedFromFormat: "dotm",
          importedFromFormatLabel: "DOTM (Macro-enabled Word template)",
          importedFromMimeType: "application/vnd.ms-word.template.macroEnabled.12",
          importedFromByteSize: 4,
        }),
      }),
    );
    expect(migrateDocsDocumentToNativeMock).toHaveBeenCalledWith({ docId: "doc-docx" });
  });

  it("routes .ods files through sheets.import-ods even when the shared parser id is xlsx", async () => {
    const blob: DriveBlob = {
      name: "Forecast.ods",
      mimeType: "application/vnd.oasis.opendocument.spreadsheet",
      bytes: new TextEncoder().encode("ods").buffer,
      byteLength: 3,
    };
    const parsed: ImportedSheet = {
      kind: "sheet",
      format: {
        id: "xlsx",
        label: "ODS (OpenDocument Spreadsheet)",
        surface: "sheets",
        supported: true,
      },
      tabs: [],
      warnings: [],
    };

    await expect(convertImportedSheetToNative(blob, parsed, "drive-ods")).resolves.toEqual({
      surface: "sheets",
      id: "sheet-ods",
    });
    expect(importOdsSheetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Forecast.ods",
        contentBase64: "b2Rz",
        metadata: expect.objectContaining({
          importedFromFormat: "ods",
          importedFromFormatLabel: "ODS (OpenDocument Spreadsheet)",
        }),
      }),
    );
    expect(importXlsxSheetMock).not.toHaveBeenCalled();
  });

  it("preserves the visible legacy Excel extension in provenance metadata", async () => {
    const blob: DriveBlob = {
      name: "Legacy Forecast.xls",
      mimeType: "application/vnd.ms-excel",
      bytes: new TextEncoder().encode("xls").buffer,
      byteLength: 3,
    };
    const parsed: ImportedSheet = {
      kind: "sheet",
      format: {
        id: "xlsx",
        label: "XLS (legacy Excel, BIFF)",
        surface: "sheets",
        supported: true,
      },
      tabs: [],
      warnings: [],
    };

    await expect(convertImportedSheetToNative(blob, parsed, "drive-xls")).resolves.toEqual({
      surface: "sheets",
      id: "sheet-xlsx",
    });
    expect(importXlsxSheetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Legacy Forecast.xls",
        metadata: expect.objectContaining({
          importedFromDriveObjectId: "drive-xls",
          importedFromFilename: "Legacy Forecast.xls",
          importedFromFormat: "xls",
          importedFromFormatLabel: "XLS (legacy Excel, BIFF)",
          importedFromMimeType: "application/vnd.ms-excel",
          importedFromByteSize: 3,
        }),
      }),
    );
  });

  it("preserves PPTX-family presentation extensions in provenance metadata", async () => {
    const blob: DriveBlob = {
      name: "Macro Roadmap.pptm",
      mimeType: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
      bytes: new TextEncoder().encode("pptm").buffer,
      byteLength: 4,
    };
    const parsed: ImportedDeck = {
      kind: "deck",
      format: {
        id: "pptx",
        label: "PPTM (PowerPoint macro-enabled presentation)",
        surface: "slides",
        supported: true,
      },
      slides: [],
      warnings: [],
    };

    await expect(convertImportedDeckToNative(blob, parsed, "drive-pptm")).resolves.toEqual({
      surface: "slides",
      id: "deck-pptx",
    });
    expect(importPptxDeckMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Macro Roadmap.pptm",
        title: "Macro Roadmap",
        contentBase64: "cHB0bQ==",
        metadata: expect.objectContaining({
          importedFromDriveObjectId: "drive-pptm",
          importedFromFilename: "Macro Roadmap.pptm",
          importedFromFormat: "pptm",
          importedFromFormatLabel: "PPTM (PowerPoint macro-enabled presentation)",
          importedFromMimeType: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
          importedFromByteSize: 4,
        }),
      }),
    );
  });
});
