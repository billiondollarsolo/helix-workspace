import type { JsonObject } from "@helix/sdk-types";

/** Canonical plugin id for the Sheets domain. */
export const sheetsPluginId = "com.helix.core.sheets";

/**
 * A spreadsheet file. Owns one or more {@link SheetTabRecord}s. Soft-deleted
 * via `deletedAt` so audit history and references stay intact.
 */
export interface SheetRecord {
  readonly id: string;
  readonly orgId: string;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly title: string;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A named, ordered tab inside a spreadsheet. */
export interface SheetTabRecord {
  readonly id: string;
  readonly orgId: string;
  readonly sheetId: string;
  readonly name: string;
  readonly position: number;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A single populated cell. Cells are stored sparsely — only non-empty cells
 * are persisted — and addressed by zero-based `row`/`col` coordinates.
 */
export interface SheetCellRecord {
  readonly id: string;
  readonly orgId: string;
  readonly sheetTabId: string;
  readonly row: number;
  readonly col: number;
  readonly value: string;
  readonly formula: string | null;
  readonly calcValue: string | null;
  readonly dependencies: readonly string[];
  readonly formulaError: string | null;
  readonly format: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A spreadsheet plus its tabs. Returned by `sheets.get` so the editor can
 * render the tab strip without a second round trip.
 */
export interface SheetWithTabs extends SheetRecord {
  readonly tabs: readonly SheetTabRecord[];
}

/** A tab plus its populated cells. Returned by `sheets.tab` reads. */
export interface SheetTabWithCells extends SheetTabRecord {
  readonly cells: readonly SheetCellRecord[];
}

export type SheetCommentAuthor = JsonObject & {
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
};

export interface SheetCommentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly sheetId: string;
  readonly parentCommentId: string | null;
  readonly actorId: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

export interface SheetCommentListItem extends SheetCommentRecord {
  readonly author?: SheetCommentAuthor | undefined;
}

/** A single cell mutation in a `sheets.cells.update` batch. */
export interface SheetCellEdit {
  readonly row: number;
  readonly col: number;
  /**
   * The new cell value. An empty string clears (deletes) the cell unless a
   * `format` is supplied, keeping storage sparse.
   */
  readonly value: string;
  readonly format?: JsonObject | undefined;
}
