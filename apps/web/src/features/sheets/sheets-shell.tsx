/* SheetsShell — the Sheets surface.

   Holds the list ⇄ editor selection in local state. The "New" button runs
   the `sheets.create` tool through TanStack Query; the list view reads
   `sheets.list` and the editor reads `sheets.get` / `sheets.tab.get`.

   The typed seed (`./seed`) is kept only as an offline fallback so the
   surface still renders when the backend is unavailable. */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { createSheet } from "./api";
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
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    if (initialSheetId !== undefined) {
      setSheetId(initialSheetId);
    }
  }, [initialSheetId]);

  // Phase 5 of the OnlyOffice migration: opening a sheet now navigates to
  // the OnlyOffice editor (`/edit/:objectId`) instead of mounting the
  // legacy in-page SheetEditor. Every code path that sets `sheetId` (URL
  // initial param, list-row click, create-mutation success) funnels
  // through this effect.
  useEffect(() => {
    if (sheetId !== null) {
      void router.navigate({ to: "/edit/$objectId", params: { objectId: sheetId } });
      setSheetId(null);
    }
  }, [sheetId, router]);

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

  return (
    <SurfaceFrame
      title="Sheets"
      icon={<Icons.Sheet />}
      searchPlaceholder="Search spreadsheets"
      searchValue={query}
      onSearchChange={setQuery}
      actions={
        <button
          type="button"
          className="btn primary"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
        </button>
      }
    >
      <SheetsList
        query={query}
        onOpen={setSheetId}
        onCreate={() => createMutation.mutate()}
        isCreating={createMutation.isPending}
        createError={createError}
      />
    </SurfaceFrame>
  );
}
