/* SheetsShell — the Sheets surface.

   Holds the list ⇄ editor selection in local state. The "New" button runs
   the `sheets.create` tool through TanStack Query; the list view reads
   `sheets.list` and the editor reads `sheets.get` / `sheets.tab.get`.

   The typed seed (`./seed`) is kept only as an offline fallback so the
   surface still renders when the backend is unavailable. */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import {
  createSheet,
  importCsvSheet,
  importOdsSheet,
  importTsvSheet,
  importXlsxSheet,
} from "./api";
import type { SheetListRow } from "./model";
import { NativeSpreadsheetEditor } from "./native-spreadsheet-editor";
import { sheetsQueryKeys } from "./queries";
import { SheetsList } from "./sheets-list";

/** Default tab name(s) for a freshly-created spreadsheet. */
const DEFAULT_TAB_NAMES = ["Sheet 1"];

export interface SheetsShellProps {
  /** Open straight into the editor for this spreadsheet id (used by Drive). */
  readonly initialSheetId?: string;
}

export function SheetsShell({ initialSheetId }: SheetsShellProps = {}) {
  const [sheetId, setSheetId] = useState<string | null>(initialSheetId ?? null);
  const [query, setQuery] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    if (initialSheetId !== undefined) {
      setSheetId(initialSheetId);
    }
  }, [initialSheetId]);

  const createMutation = useMutation({
    mutationFn: () => createSheet({ title: "Untitled spreadsheet", tabNames: DEFAULT_TAB_NAMES }),
    onMutate: () => {
      setCreateError(null);
    },
    onSuccess: async (sheet) => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      setSheetId(sheet.id);
    },
    onError: (error: unknown) => {
      setCreateError(error instanceof Error ? error.message : String(error));
    },
  });
  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      if (isXlsxFile(file)) {
        return importXlsxSheet({
          filename: file.name,
          title: titleFromSheetFilename(file.name),
          contentBase64: base64FromArrayBuffer(await file.arrayBuffer()),
          metadata: { source: "web.sheets-shell.import-xlsx" },
        });
      }
      if (isOdsFile(file)) {
        return importOdsSheet({
          filename: file.name,
          title: titleFromSheetFilename(file.name),
          contentBase64: base64FromArrayBuffer(await file.arrayBuffer()),
          metadata: { source: "web.sheets-shell.import-ods" },
        });
      }
      if (isTsvFile(file)) {
        return importTsvSheet({
          filename: file.name,
          title: titleFromSheetFilename(file.name),
          tsvText: await file.text(),
          metadata: { source: "web.sheets-shell.import-tsv" },
        });
      }
      return importCsvSheet({
        filename: file.name,
        title: titleFromSheetFilename(file.name),
        csvText: await file.text(),
        metadata: { source: "web.sheets-shell.import-csv" },
      });
    },
    onMutate: () => {
      setImportError(null);
    },
    onSuccess: async (sheet) => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      setSheetId(sheet.id);
    },
    onError: (error: unknown) => {
      setImportError(error instanceof Error ? error.message : String(error));
    },
  });

  function openSheet(id: string, openMode: SheetListRow["openMode"] = "native") {
    if (openMode === "office") {
      void router.navigate({ to: "/edit/$objectId", params: { objectId: id } });
      return;
    }
    setSheetId(id);
  }

  function chooseCsvFile() {
    if (importMutation.isPending) {
      return;
    }
    importInputRef.current?.click();
  }

  function importCsvFile(file: File | undefined) {
    if (file === undefined || importMutation.isPending) {
      return;
    }
    importMutation.mutate(file);
  }

  return (
    <SurfaceFrame
      title="Sheets"
      icon={<Icons.Sheet />}
      searchPlaceholder="Search spreadsheets"
      searchValue={query}
      onSearchChange={setQuery}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,text/csv,.tsv,text/tab-separated-values,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.ods,application/vnd.oasis.opendocument.spreadsheet"
            aria-label="Import spreadsheet"
            hidden
            onChange={(event) => {
              importCsvFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={importMutation.isPending}
            onClick={chooseCsvFile}
          >
            <Icons.Upload /> {importMutation.isPending ? "Importing..." : "Import"}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
          </button>
        </>
      }
    >
      {sheetId === null ? (
        <SheetsList
          query={query}
          onOpen={openSheet}
          onCreate={() => createMutation.mutate()}
          onImportCsv={chooseCsvFile}
          isCreating={createMutation.isPending}
          isImporting={importMutation.isPending}
          createError={createError}
          importError={importError}
        />
      ) : (
        <NativeSpreadsheetEditor sheetId={sheetId} onBack={() => setSheetId(null)} />
      )}
    </SurfaceFrame>
  );
}

function isXlsxFile(file: File): boolean {
  return file.type.includes("spreadsheetml") || file.name.toLowerCase().endsWith(".xlsx");
}

function isOdsFile(file: File): boolean {
  return (
    file.type.toLowerCase() === "application/vnd.oasis.opendocument.spreadsheet" ||
    file.name.toLowerCase().endsWith(".ods")
  );
}

function isTsvFile(file: File): boolean {
  return (
    file.type.toLowerCase() === "text/tab-separated-values" ||
    file.name.toLowerCase().endsWith(".tsv")
  );
}

function titleFromSheetFilename(filename: string): string {
  return filename.replace(/\.(csv|tsv|xlsx|ods)$/iu, "").trim() || "Imported sheet";
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
