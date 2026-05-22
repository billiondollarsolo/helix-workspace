import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { SheetsStore } from "./store.js";
import type {
  SheetCellRecord,
  SheetRecord,
  SheetTabRecord,
  SheetTabWithCells,
  SheetWithTabs,
} from "./types.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});
const formatSchema = z.record(z.unknown()).optional();

const createSchema = z.object({
  title: z.string().min(1).max(255),
  tabNames: z.array(z.string().min(1).max(120)).max(50).optional(),
  metadata: metadataSchema,
});

const listSchema = z.object({
  query: z.string().max(512).optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});

const getSchema = z.object({
  sheetId: uuidSchema,
});

const updateSchema = z.object({
  sheetId: uuidSchema,
  title: z.string().min(1).max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const deleteSchema = z.object({
  sheetId: uuidSchema,
});

const tabCreateSchema = z.object({
  sheetId: uuidSchema,
  name: z.string().min(1).max(120),
  position: z.number().int().nonnegative().optional(),
  metadata: metadataSchema,
});

const tabUpdateSchema = z.object({
  tabId: uuidSchema,
  name: z.string().min(1).max(120).optional(),
  position: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const tabDeleteSchema = z.object({
  tabId: uuidSchema,
});

const tabGetSchema = z.object({
  tabId: uuidSchema,
});

const cellEditSchema = z.object({
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  value: z.string().max(32_768),
  format: formatSchema,
});

const cellsUpdateSchema = z.object({
  tabId: uuidSchema,
  edits: z.array(cellEditSchema).min(1).max(5_000),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateSheetsToolDefinitionsOptions {
  readonly store: SheetsStore;
  /**
   * Auto-classifies newly created spreadsheets. Best-effort: classification
   * never fails the create.
   */
  readonly classifyResource?: ResourceClassifier;
}

/** Build the Sheets tool definitions. */
export function createSheetsToolDefinitions(
  options: CreateSheetsToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const { store } = options;
  return [
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "sheets.list",
      description: "List spreadsheets visible to the current actor.",
      permission: "sheets.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const page = await store.listSheets({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          ...(input.query === undefined ? {} : { query: input.query }),
          limit: input.limit,
          offset: input.offset,
        });
        return {
          sheets: page.sheets.map(serializeSheet),
          total: page.total,
          limit: page.limit,
          offset: page.offset,
        };
      },
    }),
    defineTool<z.output<typeof getSchema>, unknown>({
      id: "sheets.get",
      description: "Get a spreadsheet and its tabs.",
      permission: "sheets.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(getSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const sheet = await store.getSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: input.sheetId,
        });
        if (sheet === null) {
          throw new Error(`Unknown or inaccessible sheet: ${input.sheetId}`);
        }
        return serializeSheetWithTabs(sheet);
      },
    }),
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "sheets.create",
      description: "Create a spreadsheet with one or more tabs.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const sheet = await store.createSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title: input.title,
          ...(input.tabNames === undefined ? {} : { tabNames: input.tabNames }),
          metadata: toJsonObject(input.metadata),
        });
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "sheets.sheet",
          resourceId: sheet.id,
          derivation: { content: input.title, scanContent: true },
        });
        return serializeSheetWithTabs(sheet);
      },
    }),
    defineTool<z.output<typeof updateSchema>, unknown>({
      id: "sheets.update",
      description: "Update a spreadsheet's title or metadata.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const sheet = await store.updateSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: input.sheetId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.metadata === undefined ? {} : { metadata: toJsonObject(input.metadata) }),
        });
        if (sheet === null) {
          throw new Error(`Unknown or inaccessible sheet: ${input.sheetId}`);
        }
        return serializeSheetWithTabs(sheet);
      },
    }),
    defineTool<z.output<typeof deleteSchema>, unknown>({
      id: "sheets.delete",
      description: "Soft-delete a spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(deleteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const sheet = await store.deleteSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: input.sheetId,
        });
        if (sheet === null) {
          throw new Error(`Unknown or inaccessible sheet: ${input.sheetId}`);
        }
        return { sheetId: sheet.id, deletedAt: sheet.deletedAt?.toISOString() ?? null };
      },
    }),
    defineTool<z.output<typeof tabCreateSchema>, unknown>({
      id: "sheets.tab.create",
      description: "Create a tab in a spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(tabCreateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeTab(
          await store.createTab({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            sheetId: input.sheetId,
            name: input.name,
            ...(input.position === undefined ? {} : { position: input.position }),
            metadata: toJsonObject(input.metadata),
          }),
        ),
    }),
    defineTool<z.output<typeof tabUpdateSchema>, unknown>({
      id: "sheets.tab.update",
      description: "Rename, reorder, or re-tag a spreadsheet tab.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(tabUpdateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const tab = await store.updateTab({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          tabId: input.tabId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.position === undefined ? {} : { position: input.position }),
          ...(input.metadata === undefined ? {} : { metadata: toJsonObject(input.metadata) }),
        });
        if (tab === null) {
          throw new Error(`Unknown or inaccessible tab: ${input.tabId}`);
        }
        return serializeTab(tab);
      },
    }),
    defineTool<z.output<typeof tabDeleteSchema>, unknown>({
      id: "sheets.tab.delete",
      description: "Delete a tab and its cells from a spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(tabDeleteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const tab = await store.deleteTab({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          tabId: input.tabId,
        });
        if (tab === null) {
          throw new Error(`Unknown or inaccessible tab: ${input.tabId}`);
        }
        return { tabId: tab.id, deletedAt: tab.deletedAt?.toISOString() ?? null };
      },
    }),
    defineTool<z.output<typeof tabGetSchema>, unknown>({
      id: "sheets.tab.get",
      description: "Get a tab and its populated cells.",
      permission: "sheets.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(tabGetSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const tab = await store.getTabCells({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          tabId: input.tabId,
        });
        if (tab === null) {
          throw new Error(`Unknown or inaccessible tab: ${input.tabId}`);
        }
        return serializeTabWithCells(tab);
      },
    }),
    defineTool<z.output<typeof cellsUpdateSchema>, unknown>({
      id: "sheets.cells.update",
      description: "Apply a batch of cell edits to a tab. Empty values clear cells.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(cellsUpdateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeTabWithCells(
          await store.updateCells({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            tabId: input.tabId,
            edits: input.edits.map((edit) => ({
              row: edit.row,
              col: edit.col,
              value: edit.value,
              ...(edit.format === undefined ? {} : { format: toJsonObject(edit.format) }),
            })),
          }),
        ),
    }),
  ];
}

/** Register the Sheets tools on the runtime tool registry. */
export function registerSheetsTools(
  registry: RuntimeToolRegistry,
  options: CreateSheetsToolDefinitionsOptions,
): void {
  for (const tool of createSheetsToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function serializeSheet(sheet: SheetRecord) {
  return {
    id: sheet.id,
    orgId: sheet.orgId,
    ownerActorId: sheet.ownerActorId,
    createdByActorId: sheet.createdByActorId,
    title: sheet.title,
    metadata: sheet.metadata,
    deletedAt: sheet.deletedAt?.toISOString() ?? null,
    createdAt: sheet.createdAt.toISOString(),
    updatedAt: sheet.updatedAt.toISOString(),
  };
}

function serializeSheetWithTabs(sheet: SheetWithTabs) {
  return { ...serializeSheet(sheet), tabs: sheet.tabs.map(serializeTab) };
}

function serializeTab(tab: SheetTabRecord) {
  return {
    id: tab.id,
    orgId: tab.orgId,
    sheetId: tab.sheetId,
    name: tab.name,
    position: tab.position,
    metadata: tab.metadata,
    deletedAt: tab.deletedAt?.toISOString() ?? null,
    createdAt: tab.createdAt.toISOString(),
    updatedAt: tab.updatedAt.toISOString(),
  };
}

function serializeCell(cell: SheetCellRecord) {
  return {
    id: cell.id,
    orgId: cell.orgId,
    sheetTabId: cell.sheetTabId,
    row: cell.row,
    col: cell.col,
    value: cell.value,
    format: cell.format,
    createdAt: cell.createdAt.toISOString(),
    updatedAt: cell.updatedAt.toISOString(),
  };
}

function serializeTabWithCells(tab: SheetTabWithCells) {
  return { ...serializeTab(tab), cells: tab.cells.map(serializeCell) };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
