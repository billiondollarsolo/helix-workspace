import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import type {
  SheetCellEdit,
  SheetCellRecord,
  SheetRecord,
  SheetTabRecord,
  SheetTabWithCells,
  SheetWithTabs,
} from "./types.js";

/** Raised when a sheet/tab is missing or not visible to the actor. */
export class SheetsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsNotFoundError";
  }
}

/** Raised when a mutation would violate a domain invariant. */
export class SheetsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsValidationError";
  }
}

export interface CreateSheetInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string;
  readonly metadata?: JsonObject | undefined;
  readonly folderId?: string | null | undefined;
  /**
   * Names for the initial tabs. When omitted a single "Sheet1" tab is created
   * so a new spreadsheet is always immediately editable.
   */
  readonly tabNames?: readonly string[] | undefined;
}

export interface ListSheetsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly query?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface SheetsPage {
  readonly sheets: readonly SheetRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface UpdateSheetInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly title?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface SheetRef {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
}

export interface CreateTabInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly name: string;
  readonly position?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface UpdateTabInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
  readonly name?: string | undefined;
  readonly position?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface TabRef {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
}

export interface UpdateCellsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
  readonly edits: readonly SheetCellEdit[];
}

/**
 * Persistence contract for the Sheets domain. Implemented by both
 * {@link PostgresSheetsStore} and {@link InMemorySheetsStore} so tools can be
 * exercised without a database.
 */
export interface SheetsStore {
  createSheet(input: CreateSheetInput): Promise<SheetWithTabs>;
  listSheets(input: ListSheetsInput): Promise<SheetsPage>;
  getSheet(input: SheetRef): Promise<SheetWithTabs | null>;
  updateSheet(input: UpdateSheetInput): Promise<SheetWithTabs | null>;
  deleteSheet(input: SheetRef): Promise<SheetRecord | null>;
  createTab(input: CreateTabInput): Promise<SheetTabRecord>;
  updateTab(input: UpdateTabInput): Promise<SheetTabRecord | null>;
  deleteTab(input: TabRef): Promise<SheetTabRecord | null>;
  getTabCells(input: TabRef): Promise<SheetTabWithCells | null>;
  updateCells(input: UpdateCellsInput): Promise<SheetTabWithCells>;
}

const MAX_TITLE = 255;
const MAX_TAB_NAME = 120;
const MAX_CELL_VALUE = 32_768;
const DEFAULT_TAB_NAME = "Sheet1";

function assertTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new SheetsValidationError("Sheet title must not be empty.");
  }
  if (trimmed.length > MAX_TITLE) {
    throw new SheetsValidationError(`Sheet title must be at most ${String(MAX_TITLE)} characters.`);
  }
  return trimmed;
}

function assertTabName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new SheetsValidationError("Tab name must not be empty.");
  }
  if (trimmed.length > MAX_TAB_NAME) {
    throw new SheetsValidationError(
      `Tab name must be at most ${String(MAX_TAB_NAME)} characters.`,
    );
  }
  return trimmed;
}

function assertCellEdit(edit: SheetCellEdit): void {
  if (!Number.isInteger(edit.row) || edit.row < 0) {
    throw new SheetsValidationError("Cell row must be a non-negative integer.");
  }
  if (!Number.isInteger(edit.col) || edit.col < 0) {
    throw new SheetsValidationError("Cell column must be a non-negative integer.");
  }
  if (edit.value.length > MAX_CELL_VALUE) {
    throw new SheetsValidationError(
      `Cell value must be at most ${String(MAX_CELL_VALUE)} characters.`,
    );
  }
}

/** True when an edit clears the cell (empty value, no format). */
function isClearingEdit(edit: SheetCellEdit): boolean {
  return edit.value.length === 0 && (edit.format === undefined || isEmptyObject(edit.format));
}

function isEmptyObject(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}

// ---------------------------------------------------------------------------
// In-memory store (tests / offline).
// ---------------------------------------------------------------------------

/**
 * An in-memory {@link SheetsStore}. Mirrors the Postgres store's visibility and
 * validation semantics so tool tests can run without a database.
 */
export class InMemorySheetsStore implements SheetsStore {
  readonly #sheets = new Map<string, SheetRecord>();
  readonly #tabs = new Map<string, SheetTabRecord>();
  readonly #cells = new Map<string, SheetCellRecord>();

  async createSheet(input: CreateSheetInput): Promise<SheetWithTabs> {
    const title = assertTitle(input.title);
    const now = new Date();
    const sheet: SheetRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      title,
      metadata: {
        ...(input.metadata ?? {}),
        app: "sheets",
        folderId: input.folderId ?? null,
      },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#sheets.set(sheet.id, sheet);
    const tabNames =
      input.tabNames !== undefined && input.tabNames.length > 0
        ? input.tabNames
        : [DEFAULT_TAB_NAME];
    const tabs: SheetTabRecord[] = [];
    tabNames.forEach((name, index) => {
      tabs.push(this.#insertTab(sheet, assertTabName(name), index, now));
    });
    return { ...sheet, tabs };
  }

  async listSheets(input: ListSheetsInput): Promise<SheetsPage> {
    const query = input.query?.trim().toLowerCase();
    const visible = [...this.#sheets.values()]
      .filter(
        (sheet) =>
          sheet.orgId === input.orgId &&
          sheet.deletedAt === null &&
          this.#canAccess(sheet, input.actorId) &&
          (query === undefined ||
            query.length === 0 ||
            sheet.title.toLowerCase().includes(query)),
      )
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    return {
      sheets: visible.slice(input.offset, input.offset + input.limit),
      total: visible.length,
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getSheet(input: SheetRef): Promise<SheetWithTabs | null> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return null;
    }
    return { ...sheet, tabs: this.#tabsForSheet(sheet.id) };
  }

  async updateSheet(input: UpdateSheetInput): Promise<SheetWithTabs | null> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return null;
    }
    const updated: SheetRecord = {
      ...sheet,
      ...(input.title === undefined ? {} : { title: assertTitle(input.title) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      updatedAt: new Date(),
    };
    this.#sheets.set(updated.id, updated);
    return { ...updated, tabs: this.#tabsForSheet(updated.id) };
  }

  async deleteSheet(input: SheetRef): Promise<SheetRecord | null> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return null;
    }
    const deleted: SheetRecord = { ...sheet, deletedAt: new Date(), updatedAt: new Date() };
    this.#sheets.set(deleted.id, deleted);
    return deleted;
  }

  async createTab(input: CreateTabInput): Promise<SheetTabRecord> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
    }
    const existing = this.#tabsForSheet(sheet.id);
    const position = input.position ?? existing.length;
    return this.#insertTab(sheet, assertTabName(input.name), position, new Date(), input.metadata);
  }

  async updateTab(input: UpdateTabInput): Promise<SheetTabRecord | null> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      return null;
    }
    const updated: SheetTabRecord = {
      ...tab,
      ...(input.name === undefined ? {} : { name: assertTabName(input.name) }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      updatedAt: new Date(),
    };
    this.#tabs.set(updated.id, updated);
    this.#touchSheet(updated.sheetId);
    return updated;
  }

  async deleteTab(input: TabRef): Promise<SheetTabRecord | null> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      return null;
    }
    const remaining = this.#tabsForSheet(tab.sheetId).filter((candidate) => candidate.id !== tab.id);
    if (remaining.length === 0) {
      throw new SheetsValidationError("A spreadsheet must keep at least one tab.");
    }
    const deleted: SheetTabRecord = { ...tab, deletedAt: new Date(), updatedAt: new Date() };
    this.#tabs.set(deleted.id, deleted);
    for (const cell of [...this.#cells.values()]) {
      if (cell.sheetTabId === tab.id) {
        this.#cells.delete(cellKey(cell.sheetTabId, cell.row, cell.col));
      }
    }
    this.#touchSheet(tab.sheetId);
    return deleted;
  }

  async getTabCells(input: TabRef): Promise<SheetTabWithCells | null> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      return null;
    }
    return { ...tab, cells: this.#cellsForTab(tab.id) };
  }

  async updateCells(input: UpdateCellsInput): Promise<SheetTabWithCells> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
    }
    const now = new Date();
    for (const edit of input.edits) {
      assertCellEdit(edit);
      const key = cellKey(tab.id, edit.row, edit.col);
      if (isClearingEdit(edit)) {
        this.#cells.delete(key);
        continue;
      }
      const existing = this.#cells.get(key);
      this.#cells.set(key, {
        id: existing?.id ?? randomUUID(),
        orgId: tab.orgId,
        sheetTabId: tab.id,
        row: edit.row,
        col: edit.col,
        value: edit.value,
        format: edit.format ?? existing?.format ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    this.#touchSheet(tab.sheetId);
    return { ...tab, cells: this.#cellsForTab(tab.id) };
  }

  #insertTab(
    sheet: SheetRecord,
    name: string,
    position: number,
    now: Date,
    metadata?: JsonObject,
  ): SheetTabRecord {
    const tab: SheetTabRecord = {
      id: randomUUID(),
      orgId: sheet.orgId,
      sheetId: sheet.id,
      name,
      position,
      metadata: metadata ?? {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#tabs.set(tab.id, tab);
    this.#touchSheet(sheet.id);
    return tab;
  }

  #tabsForSheet(sheetId: string): SheetTabRecord[] {
    return [...this.#tabs.values()]
      .filter((tab) => tab.sheetId === sheetId && tab.deletedAt === null)
      .sort((left, right) => left.position - right.position || left.createdAt.getTime() - right.createdAt.getTime());
  }

  #cellsForTab(tabId: string): SheetCellRecord[] {
    return [...this.#cells.values()]
      .filter((cell) => cell.sheetTabId === tabId)
      .sort((left, right) => left.row - right.row || left.col - right.col);
  }

  #canAccess(sheet: SheetRecord, actorId: string): boolean {
    return sheet.ownerActorId === actorId || sheet.createdByActorId === actorId;
  }

  #requireVisible(input: SheetRef | UpdateSheetInput): SheetRecord | null {
    const sheet = this.#sheets.get(input.sheetId);
    if (
      sheet === undefined ||
      sheet.orgId !== input.orgId ||
      sheet.deletedAt !== null ||
      !this.#canAccess(sheet, input.actorId)
    ) {
      return null;
    }
    return sheet;
  }

  #requireTab(input: { orgId: string; actorId: string; tabId: string }): SheetTabRecord | null {
    const tab = this.#tabs.get(input.tabId);
    if (tab === undefined || tab.orgId !== input.orgId || tab.deletedAt !== null) {
      return null;
    }
    const sheet = this.#requireVisible({
      orgId: input.orgId,
      actorId: input.actorId,
      sheetId: tab.sheetId,
    });
    return sheet === null ? null : tab;
  }

  #touchSheet(sheetId: string): void {
    const sheet = this.#sheets.get(sheetId);
    if (sheet !== undefined) {
      this.#sheets.set(sheetId, { ...sheet, updatedAt: new Date() });
    }
  }
}

function cellKey(tabId: string, row: number, col: number): string {
  return `${tabId}:${String(row)}:${String(col)}`;
}

// ---------------------------------------------------------------------------
// Postgres store.
// ---------------------------------------------------------------------------

type SqlLike = postgres.Sql | postgres.TransactionSql;

interface SheetRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly title: string;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SheetTabRow {
  readonly id: string;
  readonly org_id: string;
  readonly sheet_id: string;
  readonly name: string;
  readonly position: number;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SheetCellRow {
  readonly id: string;
  readonly org_id: string;
  readonly sheet_tab_id: string;
  readonly row: number;
  readonly col: number;
  readonly value: string;
  readonly format: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Postgres-backed {@link SheetsStore}. */
export class PostgresSheetsStore implements SheetsStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createSheet(input: CreateSheetInput): Promise<SheetWithTabs> {
    const title = assertTitle(input.title);
    const tabNames = (
      input.tabNames !== undefined && input.tabNames.length > 0
        ? input.tabNames
        : [DEFAULT_TAB_NAME]
    ).map(assertTabName);
    return this.sql.begin(async (tx) => {
      const sheetRows = (await tx`
        insert into sheets (org_id, owner_actor_id, created_by_actor_id, title, metadata)
        values (
          ${input.orgId}, ${input.actorId}, ${input.actorId}, ${title},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly SheetRow[];
      const sheet = mapSheet(sheetRows[0]);
      const tabs: SheetTabRecord[] = [];
      for (let index = 0; index < tabNames.length; index += 1) {
        const tabRows = (await tx`
          insert into sheet_tabs (org_id, sheet_id, name, position)
          values (${input.orgId}, ${sheet.id}, ${tabNames[index] ?? DEFAULT_TAB_NAME}, ${index})
          returning *
        `) as unknown as readonly SheetTabRow[];
        tabs.push(mapTab(tabRows[0]));
      }
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${sheet.id}, ${input.orgId}, ${input.actorId}, 'file',
          ${`sheets/${input.orgId}/${sheet.id}`},
          'application/vnd.helix.spreadsheet', 0, null,
          ${tx.json(toSqlJson({ ...(input.metadata ?? {}), app: "sheets", sheetId: sheet.id, name: title, title, folderId: input.folderId ?? null }))}
        )
        on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
      `;
      await grantObjectAccess(tx, {
        orgId: input.orgId,
        objectId: sheet.id,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.created",
        objectId: sheet.id,
        payload: { title, tabCount: tabs.length },
      });
      return { ...sheet, tabs };
    });
  }

  async listSheets(input: ListSheetsInput): Promise<SheetsPage> {
    const query = input.query?.trim();
    const titleQuery = query === undefined || query.length === 0 ? null : `%${query}%`;
    const rows = (await this.sql`
      select *, count(*) over () as total_count
      from sheets
      where org_id = ${input.orgId}
        and deleted_at is null
        and (owner_actor_id = ${input.actorId} or created_by_actor_id = ${input.actorId})
        and (${titleQuery}::text is null or title ilike ${titleQuery})
      order by updated_at desc
      limit ${input.limit}
      offset ${input.offset}
    `) as unknown as readonly (SheetRow & { readonly total_count: string })[];
    return {
      sheets: rows.map(mapSheet),
      total: rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0,
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getSheet(input: SheetRef): Promise<SheetWithTabs | null> {
    const sheet = await selectVisibleSheet(this.sql, input);
    if (sheet === null) {
      return null;
    }
    return { ...sheet, tabs: await selectTabs(this.sql, input.orgId, sheet.id) };
  }

  async updateSheet(input: UpdateSheetInput): Promise<SheetWithTabs | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectVisibleSheet(tx, input);
      if (existing === null) {
        return null;
      }
      const title = input.title === undefined ? existing.title : assertTitle(input.title);
      const metadata = input.metadata ?? existing.metadata;
      const rows = (await tx`
        update sheets
        set title = ${title}, metadata = ${tx.json(toSqlJson(metadata))}, updated_at = now()
        where id = ${input.sheetId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetRow[];
      if (rows[0] === undefined) {
        return null;
      }
      const sheet = mapSheet(rows[0]);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.updated",
        objectId: sheet.id,
        payload: { title },
      });
      return { ...sheet, tabs: await selectTabs(tx, input.orgId, sheet.id) };
    });
  }

  async deleteSheet(input: SheetRef): Promise<SheetRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectVisibleSheet(tx, input);
      if (existing === null) {
        return null;
      }
      const rows = (await tx`
        update sheets set deleted_at = now(), updated_at = now()
        where id = ${input.sheetId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetRow[];
      if (rows[0] === undefined) {
        return null;
      }
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.deleted",
        objectId: input.sheetId,
        payload: {},
      });
      return mapSheet(rows[0]);
    });
  }

  async createTab(input: CreateTabInput): Promise<SheetTabRecord> {
    const name = assertTabName(input.name);
    return this.sql.begin(async (tx) => {
      const sheet = await selectVisibleSheet(tx, input);
      if (sheet === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
      }
      const positionRows = (await tx`
        select coalesce(max(position) + 1, 0) as next_position
        from sheet_tabs
        where sheet_id = ${input.sheetId} and deleted_at is null
      `) as unknown as readonly { readonly next_position: number }[];
      const position = input.position ?? (positionRows[0]?.next_position ?? 0);
      const rows = (await tx`
        insert into sheet_tabs (org_id, sheet_id, name, position, metadata)
        values (
          ${input.orgId}, ${input.sheetId}, ${name}, ${position},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly SheetTabRow[];
      await touchSheet(tx, input.orgId, input.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.tab.created",
        objectId: input.sheetId,
        payload: { tabId: rows[0]?.id ?? null, name },
      });
      return mapTab(rows[0]);
    });
  }

  async updateTab(input: UpdateTabInput): Promise<SheetTabRecord | null> {
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        return null;
      }
      const name = input.name === undefined ? tab.name : assertTabName(input.name);
      const position = input.position ?? tab.position;
      const metadata = input.metadata ?? tab.metadata;
      const rows = (await tx`
        update sheet_tabs
        set name = ${name}, position = ${position},
            metadata = ${tx.json(toSqlJson(metadata))}, updated_at = now()
        where id = ${input.tabId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetTabRow[];
      if (rows[0] === undefined) {
        return null;
      }
      await touchSheet(tx, input.orgId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.tab.updated",
        objectId: tab.sheetId,
        payload: { tabId: input.tabId, name },
      });
      return mapTab(rows[0]);
    });
  }

  async deleteTab(input: TabRef): Promise<SheetTabRecord | null> {
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        return null;
      }
      const remainingRows = (await tx`
        select count(*)::int as remaining
        from sheet_tabs
        where sheet_id = ${tab.sheetId} and deleted_at is null and id <> ${input.tabId}
      `) as unknown as readonly { readonly remaining: number }[];
      if ((remainingRows[0]?.remaining ?? 0) === 0) {
        throw new SheetsValidationError("A spreadsheet must keep at least one tab.");
      }
      const rows = (await tx`
        update sheet_tabs set deleted_at = now(), updated_at = now()
        where id = ${input.tabId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetTabRow[];
      if (rows[0] === undefined) {
        return null;
      }
      await tx`delete from sheet_cells where sheet_tab_id = ${input.tabId}`;
      await touchSheet(tx, input.orgId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.tab.deleted",
        objectId: tab.sheetId,
        payload: { tabId: input.tabId },
      });
      return mapTab(rows[0]);
    });
  }

  async getTabCells(input: TabRef): Promise<SheetTabWithCells | null> {
    const tab = await selectVisibleTab(this.sql, input);
    if (tab === null) {
      return null;
    }
    return { ...tab, cells: await selectCells(this.sql, input.tabId) };
  }

  async updateCells(input: UpdateCellsInput): Promise<SheetTabWithCells> {
    for (const edit of input.edits) {
      assertCellEdit(edit);
    }
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
      }
      for (const edit of input.edits) {
        if (isClearingEdit(edit)) {
          await tx`
            delete from sheet_cells
            where sheet_tab_id = ${input.tabId} and row = ${edit.row} and col = ${edit.col}
          `;
          continue;
        }
        await tx`
          insert into sheet_cells (org_id, sheet_tab_id, row, col, value, format)
          values (
            ${input.orgId}, ${input.tabId}, ${edit.row}, ${edit.col}, ${edit.value},
            ${tx.json(toSqlJson(edit.format ?? {}))}
          )
          on conflict (sheet_tab_id, row, col) do update set
            value = excluded.value,
            format = case
              when ${edit.format === undefined} then sheet_cells.format
              else excluded.format
            end,
            updated_at = now()
        `;
      }
      await touchSheet(tx, input.orgId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.cells.updated",
        objectId: tab.sheetId,
        payload: { tabId: input.tabId, editCount: input.edits.length },
      });
      return { ...tab, cells: await selectCells(tx, input.tabId) };
    });
  }
}

async function selectVisibleSheet(
  sql: SqlLike,
  input: SheetRef | UpdateSheetInput,
): Promise<SheetRecord | null> {
  const rows = (await sql`
    select *
    from sheets
    where id = ${input.sheetId}
      and org_id = ${input.orgId}
      and deleted_at is null
      and (owner_actor_id = ${input.actorId} or created_by_actor_id = ${input.actorId})
    limit 1
  `) as unknown as readonly SheetRow[];
  return rows[0] === undefined ? null : mapSheet(rows[0]);
}

async function selectVisibleTab(
  sql: SqlLike,
  input: { orgId: string; actorId: string; tabId: string },
): Promise<SheetTabRecord | null> {
  const rows = (await sql`
    select t.*
    from sheet_tabs t
    join sheets s on s.id = t.sheet_id and s.org_id = t.org_id
    where t.id = ${input.tabId}
      and t.org_id = ${input.orgId}
      and t.deleted_at is null
      and s.deleted_at is null
      and (s.owner_actor_id = ${input.actorId} or s.created_by_actor_id = ${input.actorId})
    limit 1
  `) as unknown as readonly SheetTabRow[];
  return rows[0] === undefined ? null : mapTab(rows[0]);
}

async function selectTabs(
  sql: SqlLike,
  orgId: string,
  sheetId: string,
): Promise<readonly SheetTabRecord[]> {
  const rows = (await sql`
    select *
    from sheet_tabs
    where org_id = ${orgId} and sheet_id = ${sheetId} and deleted_at is null
    order by position asc, created_at asc
  `) as unknown as readonly SheetTabRow[];
  return rows.map(mapTab);
}

async function selectCells(sql: SqlLike, tabId: string): Promise<readonly SheetCellRecord[]> {
  const rows = (await sql`
    select *
    from sheet_cells
    where sheet_tab_id = ${tabId}
    order by row asc, col asc
  `) as unknown as readonly SheetCellRow[];
  return rows.map(mapCell);
}

async function touchSheet(sql: SqlLike, orgId: string, sheetId: string): Promise<void> {
  await sql`
    update sheets set updated_at = now()
    where id = ${sheetId} and org_id = ${orgId} and deleted_at is null
  `;
}

/**
 * Append a hash-chained {@link activity} row and an {@link outbox} event for a
 * Sheets mutation, matching the Docs domain's audit pattern.
 */
async function appendSheetsActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = (await sql`
    select this_hash from activity
    where org_id = ${input.orgId}
    order by created_at desc
    limit 1
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const thisHash = `${prevHash ?? "root"}:${input.verb}:${input.objectId}:${String(Date.now())}`;
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (
      ${input.orgId}, ${input.actorId}, ${input.verb}, 'sheet', ${input.objectId},
      ${sql.json(toSqlJson(input.payload))}, ${prevHash}, ${thisHash}
    )
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        sheetId: input.objectId,
        ...input.payload,
      }),
    )})
  `;
}

function mapSheet(row: SheetRow | undefined): SheetRecord {
  if (row === undefined) {
    throw new Error("Expected sheet row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    createdByActorId: row.created_by_actor_id,
    title: row.title,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTab(row: SheetTabRow | undefined): SheetTabRecord {
  if (row === undefined) {
    throw new Error("Expected sheet tab row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    sheetId: row.sheet_id,
    name: row.name,
    position: row.position,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCell(row: SheetCellRow | undefined): SheetCellRecord {
  if (row === undefined) {
    throw new Error("Expected sheet cell row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    sheetTabId: row.sheet_tab_id,
    row: row.row,
    col: row.col,
    value: row.value,
    format: row.format,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
