/* SheetsShell — the Sheets surface.

   Holds the list ⇄ editor selection in local state. The "New" button runs
   the `sheets.create` tool through TanStack Query; the list view reads
   `sheets.list` and the editor reads `sheets.get` / `sheets.tab.get`.

   The typed seed (`./seed`) is kept only as an offline fallback so the
   surface still renders when the backend is unavailable. */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import {
  EDITORS_ALPHA_DISABLED_TITLE,
  EditorsAlphaBadge,
  useEditorsAlpha,
} from "@/features/apps/editors-alpha";
import { uploadDriveFile } from "@/features/drive/api";
import { createSheet } from "./api";
import type { SheetListRow } from "./model";
import { NativeSpreadsheetEditor } from "./native-spreadsheet-editor";
import { sheetQueryOptions, sheetsQueryKeys } from "./queries";
import { SheetsList } from "./sheets-list";
import { UniversalEditorRouter } from "@/features/_open/ui/UniversalEditorRouter";

/** Default tab name(s) for a freshly-created spreadsheet. */
const DEFAULT_TAB_NAMES = ["Sheet 1"];
const SPREADSHEET_IMPORT_ACCEPT = [
  ".csv",
  "text/csv",
  ".tsv",
  "text/tab-separated-values",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".xls",
  ".xltx",
  ".xltm",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  "application/vnd.ms-excel.template.macroEnabled.12",
  ".ods",
  "application/vnd.oasis.opendocument.spreadsheet",
].join(",");

export interface SheetsShellProps {
  /** Open straight into the editor for this spreadsheet id (used by Drive). */
  readonly initialSheetId?: string;
  readonly initialOpenMode?: SheetListRow["openMode"];
  readonly initialSearchQuery?: string;
  readonly onSearchQueryChange?: (query: string) => void;
}

export function SheetsShell({
  initialSheetId,
  initialOpenMode,
  initialSearchQuery = "",
  onSearchQueryChange,
}: SheetsShellProps = {}) {
  const [sheetId, setSheetId] = useState<string | null>(initialSheetId ?? null);
  const [sheetOpenMode, setSheetOpenMode] = useState<SheetListRow["openMode"] | null>(
    initialOpenMode ?? null,
  );
  const [query, setQuery] = useState(initialSearchQuery);
  const [createError, setCreateError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();
  const editorsAlpha = useEditorsAlpha();

  useEffect(() => {
    if (initialSheetId !== undefined) {
      setSheetId(initialSheetId);
      setSheetOpenMode(initialOpenMode ?? null);
    }
  }, [initialOpenMode, initialSheetId]);

  useEffect(() => {
    setQuery(initialSearchQuery);
  }, [initialSearchQuery]);

  const createMutation = useMutation({
    mutationFn: () => createSheet({ title: "Untitled spreadsheet", tabNames: DEFAULT_TAB_NAMES }),
    onMutate: () => {
      setCreateError(null);
    },
    onSuccess: async (sheet) => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      setSheetId(sheet.id);
      setSheetOpenMode("native");
      void router.navigate({ to: "/sheets", search: { sheet: sheet.id } });
    },
    onError: (error: unknown) => {
      setCreateError(error instanceof Error ? error.message : String(error));
    },
  });
  const importMutation = useMutation({
    mutationFn: (file: File) => uploadDriveFile({ file, folderId: null }),
    onMutate: () => {
      setImportError(null);
    },
    onSuccess: async (uploaded) => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      setSheetId(null);
      setSheetOpenMode(null);
      void router.navigate({
        to: "/open/$objectId",
        params: { objectId: uploaded.objectId },
      });
    },
    onError: (error: unknown) => {
      setImportError(error instanceof Error ? error.message : String(error));
    },
  });

  function openSheet(id: string, openMode: SheetListRow["openMode"] = "native") {
    setSheetId(id);
    setSheetOpenMode(openMode ?? null);
    void router.navigate({
      to: "/sheets",
      search: { sheet: id, ...(openMode === "office" ? { open: "office" as const } : {}) },
    });
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
      onSearchChange={(nextQuery) => {
        setQuery(nextQuery);
        onSearchQueryChange?.(nextQuery);
      }}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept={SPREADSHEET_IMPORT_ACCEPT}
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
            disabled={createMutation.isPending || !editorsAlpha.enabled}
            title={editorsAlpha.enabled ? undefined : EDITORS_ALPHA_DISABLED_TITLE}
            onClick={() => createMutation.mutate()}
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
          </button>
          {editorsAlpha.enabled ? <EditorsAlphaBadge /> : null}
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
          editorsEnabled={editorsAlpha.enabled}
        />
      ) : (
        <SheetsEditorSurface
          sheetId={sheetId}
          openMode={sheetOpenMode}
          editorsEnabled={editorsAlpha.enabled}
          onOpenSheet={openSheet}
          onBack={() => {
            setSheetId(null);
            setSheetOpenMode(null);
            void router.navigate({ to: "/sheets", search: {} });
          }}
        />
      )}
    </SurfaceFrame>
  );
}

/** Routes a sheet id either to the native editor (when sheets.get returns a
 *  native record) or to the universal-loader fallback (when the id refers to
 *  a raw Drive blob like .xlsx / .csv / .ods uploaded via Drive). */
function SheetsEditorSurface({
  sheetId,
  openMode,
  editorsEnabled,
  onOpenSheet,
  onBack,
}: {
  readonly sheetId: string;
  readonly openMode: SheetListRow["openMode"] | null;
  readonly editorsEnabled: boolean;
  readonly onOpenSheet: (sheetId: string) => void;
  readonly onBack: () => void;
}) {
  const shouldTryNative = openMode !== "office" && editorsEnabled;
  const nativeQuery = useQuery(sheetQueryOptions(sheetId, shouldTryNative));
  const nativeFetch = shouldTryNative
    ? nativeQuery
    : { isLoading: false, isError: false, isSuccess: true, data: null };
  return (
    <UniversalEditorRouter
      objectId={sheetId}
      surface="sheets"
      nativeEditingEnabled={editorsEnabled}
      nativeFetch={nativeFetch}
      renderNative={() => (
        <NativeSpreadsheetEditor sheetId={sheetId} onBack={onBack} onOpenSheet={onOpenSheet} />
      )}
    />
  );
}
