/* SheetsShell — the Sheets surface.

   Holds the list ⇄ editor selection in local state. The "New" button runs
   the `sheets.create` tool through TanStack Query; the list view reads
   `sheets.list` and the editor reads `sheets.get` / `sheets.tab.get`.

   The typed seed (`./seed`) is kept only as an offline fallback so the
   surface still renders when the backend is unavailable. */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { createSheet } from "./api";
import { sheetsQueryKeys } from "./queries";
import { SheetEditor } from "./sheet-editor";
import { SheetsList } from "./sheets-list";
import { SHEET_TABS } from "./seed";

const DEFAULT_TAB_NAMES = SHEET_TABS.map((tab) => tab.name);

export interface SheetsShellProps {
  /** Open straight into the editor for this spreadsheet id (used by Drive). */
  readonly initialSheetId?: string;
}

export function SheetsShell({ initialSheetId }: SheetsShellProps = {}) {
  const [sheetId, setSheetId] = useState<string | null>(initialSheetId ?? null);
  const [query, setQuery] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const queryClient = useQueryClient();

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

  const inEditor = sheetId !== null;

  return (
    <SurfaceFrame
      title="Sheets"
      icon={<Icons.Sheet />}
      searchPlaceholder="Search spreadsheets"
      searchValue={inEditor ? undefined : query}
      onSearchChange={inEditor ? undefined : setQuery}
      actions={
        inEditor ? undefined : (
          <button
            type="button"
            className="btn primary"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
          </button>
        )
      }
    >
      {sheetId === null ? (
        <SheetsList
          query={query}
          onOpen={setSheetId}
          onCreate={() => createMutation.mutate()}
          isCreating={createMutation.isPending}
          createError={createError}
        />
      ) : (
        <SheetEditor sheetId={sheetId} onBack={() => setSheetId(null)} />
      )}
    </SurfaceFrame>
  );
}
