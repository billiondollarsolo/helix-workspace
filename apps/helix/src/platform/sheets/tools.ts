import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import type {
  Cell,
  CellIsOperators,
  CellValue,
  ConditionalFormattingRule,
  DataValidation,
  Fill,
  Style,
  Worksheet,
} from "exceljs";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { SheetsStore, SheetVersionRecord } from "./store.js";
import type {
  SheetCellEdit,
  SheetCellRecord,
  SheetCommentListItem,
  SheetCommentRecord,
  SheetRecord,
  SheetTabRecord,
  SheetTabWithCells,
  SheetWithTabs,
} from "./types.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.string(), z.unknown()).default({});
const SUPPORTED_CUSTOM_NUMBER_FORMATS = [
  "#,##0",
  "#,##0.00",
  "0",
  "0.00",
  "$#,##0.00",
  "0%",
  "0.00%",
  "#,##0.00;[Red](#,##0.00);-;@",
  "$#,##0.00;[Red]($#,##0.00);$0.00;@",
  "0.00%;[Red](0.00%);0%;@",
  "m/d/yyyy",
  "mm/dd/yyyy",
  "mmm d, yyyy",
] as const;
const SUPPORTED_CUSTOM_NUMBER_FORMAT_SET = new Set<string>(SUPPORTED_CUSTOM_NUMBER_FORMATS);
const SUPPORTED_DATA_VALIDATION_DATE_LOCALES = new Set(["iso", "en-US", "en-GB", "de-DE"]);
const formatSchema = z
  .record(z.unknown())
  .superRefine((format, ctx) => {
    const linkUrl = format["linkUrl"];
    if (linkUrl !== undefined && linkUrl !== null && linkUrl !== "") {
      if (typeof linkUrl !== "string" || normalizedSafeSheetLinkUrl(linkUrl) === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["linkUrl"],
          message: "Cell link URL must use http, https, or mailto.",
        });
      }
    }
    if (format["numberFormat"] === "custom") {
      const customNumberFormat = format["customNumberFormat"];
      if (
        typeof customNumberFormat !== "string" ||
        !SUPPORTED_CUSTOM_NUMBER_FORMAT_SET.has(customNumberFormat)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customNumberFormat"],
          message: "Unsupported custom number format.",
        });
      }
    }
    const dataValidation = format["dataValidation"];
    if (
      typeof dataValidation === "object" &&
      dataValidation !== null &&
      !Array.isArray(dataValidation)
    ) {
      const mode = (dataValidation as Record<string, unknown>)["mode"];
      if (mode !== undefined && mode !== "warn" && mode !== "reject") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataValidation", "mode"],
          message: "Unsupported data validation mode.",
        });
      }
      const namedRangeId = (dataValidation as Record<string, unknown>)["namedRangeId"];
      if (namedRangeId !== undefined && typeof namedRangeId !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataValidation", "namedRangeId"],
          message: "Named range validation source must be a string.",
        });
      }
      const formula = (dataValidation as Record<string, unknown>)["formula"];
      if (formula !== undefined && typeof formula !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataValidation", "formula"],
          message: "Validation formula must be a string.",
        });
      }
      const locale = (dataValidation as Record<string, unknown>)["locale"];
      if (
        locale !== undefined &&
        (typeof locale !== "string" || !SUPPORTED_DATA_VALIDATION_DATE_LOCALES.has(locale))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataValidation", "locale"],
          message: "Unsupported data validation date locale.",
        });
      }
    }
  })
  .optional();

const createSchema = z.object({
  title: z.string().min(1).max(255),
  tabNames: z.array(z.string().min(1).max(120)).max(50).optional(),
  metadata: metadataSchema,
});

const copySchema = z.object({
  sheetId: uuidSchema,
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  metadata: metadataSchema,
});

const importCsvSchema = z.object({
  filename: z.string().min(1).max(255),
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  csvText: z.string().max(5_000_000),
  metadata: metadataSchema,
});

const importTsvSchema = z.object({
  filename: z.string().min(1).max(255),
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  tsvText: z.string().max(5_000_000),
  metadata: metadataSchema,
});

const importXlsxSchema = z.object({
  filename: z.string().min(1).max(255),
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  contentBase64: z.string().min(1).max(25_000_000),
  metadata: metadataSchema,
});

const importOdsSchema = z.object({
  filename: z.string().min(1).max(255),
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  contentBase64: z.string().min(1).max(25_000_000),
  metadata: metadataSchema,
});

const exportSchema = z.object({
  sheetId: uuidSchema,
  format: z.enum(["csv", "tsv", "xlsx", "ods"]).default("xlsx"),
  tabId: uuidSchema.optional(),
});

const listSchema = z.object({
  query: z.string().max(512).optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});

const getSchema = z.object({
  sheetId: uuidSchema,
});

const listVersionsSchema = z.object({
  sheetId: uuidSchema,
  limit: z.number().int().positive().max(100).default(50),
});

const restoreVersionSchema = z.object({
  sheetId: uuidSchema,
  versionId: uuidSchema,
});

const updateSchema = z.object({
  sheetId: uuidSchema,
  title: z.string().min(1).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const tabDeleteSchema = z.object({
  tabId: uuidSchema,
});

const cellEditSchema = z.object({
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  value: z.string().max(32_768),
  format: formatSchema,
});

const cellWindowSchema = z.object({
  startRow: z.number().int().nonnegative(),
  startCol: z.number().int().nonnegative(),
  endRow: z.number().int().nonnegative(),
  endCol: z.number().int().nonnegative(),
});

const tabGetSchema = z.object({
  tabId: uuidSchema,
  window: cellWindowSchema.optional(),
});

const cellsUpdateSchema = z.object({
  tabId: uuidSchema,
  edits: z.array(cellEditSchema).min(1).max(5_000),
  window: cellWindowSchema.optional(),
});

const rangeSchema = z.object({
  startRow: z.number().int().nonnegative(),
  startCol: z.number().int().nonnegative(),
  endRow: z.number().int().nonnegative(),
  endCol: z.number().int().nonnegative(),
});

const rangeSortSchema = z.object({
  tabId: uuidSchema,
  range: rangeSchema,
  direction: z.enum(["asc", "desc"]),
  window: cellWindowSchema.optional(),
});

const commentStatusSchema = z.enum(["open", "resolved", "all"]);

const createCommentSchema = z.object({
  sheetId: uuidSchema,
  parentCommentId: uuidSchema.optional(),
  body: z.string().trim().min(1).max(10_000),
  anchor: z.record(z.string(), z.unknown()).default({}),
  metadata: metadataSchema,
});

const listCommentsSchema = z.object({
  sheetId: uuidSchema,
  status: commentStatusSchema.default("open"),
});

const resolveCommentSchema = z.object({
  commentId: uuidSchema,
});

const updateCommentSchema = z.object({
  commentId: uuidSchema,
  body: z.string().trim().min(1).max(10_000),
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
    defineTool<z.output<typeof listVersionsSchema>, unknown>({
      id: "sheets.version.list",
      description: "List saved snapshot versions for a spreadsheet.",
      permission: "sheets.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listVersionsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const versions = await store.listVersions({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: input.sheetId,
          limit: input.limit,
        });
        return { versions: versions.map(serializeVersion) };
      },
    }),
    defineTool<z.output<typeof restoreVersionSchema>, unknown>({
      id: "sheets.version.restore",
      description: "Restore a spreadsheet from a saved snapshot version.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(restoreVersionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const restored = await store.restoreVersion({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: input.sheetId,
          versionId: input.versionId,
        });
        if (restored === null) {
          throw new Error(`Unknown or inaccessible sheet version: ${input.versionId}`);
        }
        return serializeSheetWithTabs(restored);
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
    defineTool<z.output<typeof copySchema>, unknown>({
      id: "sheets.copy",
      description: "Copy a native spreadsheet with its tabs, cells, and metadata.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(copySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const sheet = await store.copySheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: input.sheetId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject(input.metadata),
        });
        if (sheet === null) {
          throw new Error(`Unknown or inaccessible sheet: ${input.sheetId}`);
        }
        return serializeSheetWithTabs(sheet);
      },
    }),
    defineTool<z.output<typeof importCsvSchema>, unknown>({
      id: "sheets.import-csv",
      description: "Import a CSV file into a native Helix spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(importCsvSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const parsed = parseCsvForImport(input.csvText);
        const title = input.title ?? titleFromCsvFilename(input.filename);
        const tabName = tabNameFromCsvFilename(input.filename);
        const sheet = await store.createSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title,
          tabNames: [tabName],
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject({
            ...input.metadata,
            importedFrom: "csv",
            sourceFilename: input.filename,
          }),
        });
        const firstTab = sheet.tabs[0];
        if (firstTab === undefined) {
          throw new Error("CSV import created a spreadsheet without a tab.");
        }
        if (parsed.edits.length > 0) {
          await store.updateCells({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            tabId: firstTab.id,
            edits: parsed.edits,
          });
        }
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "sheets.sheet",
          resourceId: sheet.id,
          derivation: { content: `${title}\n${input.csvText.slice(0, 8_000)}`, scanContent: true },
        });
        const imported = await store.getSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: sheet.id,
        });
        if (imported === null) {
          throw new Error(`Unknown or inaccessible sheet: ${sheet.id}`);
        }
        return {
          ...serializeSheetWithTabs(imported),
          import: {
            format: "csv",
            filename: input.filename,
            rowCount: parsed.rowCount,
            columnCount: parsed.columnCount,
            populatedCellCount: parsed.edits.length,
          },
        };
      },
    }),
    defineTool<z.output<typeof importTsvSchema>, unknown>({
      id: "sheets.import-tsv",
      description: "Import a TSV file into a native Helix spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(importTsvSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const parsed = parseTsvForImport(input.tsvText);
        const title = input.title ?? titleFromTsvFilename(input.filename);
        const tabName = tabNameFromTsvFilename(input.filename);
        const sheet = await store.createSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title,
          tabNames: [tabName],
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject({
            ...input.metadata,
            importedFrom: "tsv",
            sourceFilename: input.filename,
          }),
        });
        const firstTab = sheet.tabs[0];
        if (firstTab === undefined) {
          throw new Error("TSV import created a spreadsheet without a tab.");
        }
        if (parsed.edits.length > 0) {
          await store.updateCells({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            tabId: firstTab.id,
            edits: parsed.edits,
          });
        }
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "sheets.sheet",
          resourceId: sheet.id,
          derivation: { content: `${title}\n${input.tsvText.slice(0, 8_000)}`, scanContent: true },
        });
        const imported = await store.getSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: sheet.id,
        });
        if (imported === null) {
          throw new Error(`Unknown or inaccessible sheet: ${sheet.id}`);
        }
        return {
          ...serializeSheetWithTabs(imported),
          import: {
            format: "tsv",
            filename: input.filename,
            rowCount: parsed.rowCount,
            columnCount: parsed.columnCount,
            populatedCellCount: parsed.edits.length,
          },
        };
      },
    }),
    defineTool<z.output<typeof importXlsxSchema>, unknown>({
      id: "sheets.import-xlsx",
      description: "Import an XLSX workbook into a native Helix spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(importXlsxSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const parsed = await parseXlsxForImport(input.contentBase64);
        const title = input.title ?? titleFromWorkbookFilename(input.filename);
        const sourceFormat = spreadsheetWorkbookSourceFormat(input.filename);
        const sheet = await store.createSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title,
          tabNames: parsed.tabs.map((tab) => tab.name),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject({
            ...input.metadata,
            importedFrom: sourceFormat,
            sourceFilename: input.filename,
          }),
        });
        for (const [index, importedTab] of parsed.tabs.entries()) {
          const tab = sheet.tabs[index];
          if (tab === undefined || importedTab.edits.length === 0) {
            continue;
          }
          await store.updateCells({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            tabId: tab.id,
            edits: importedTab.edits,
          });
        }
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "sheets.sheet",
          resourceId: sheet.id,
          derivation: { content: title, scanContent: true },
        });
        const imported = await store.getSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: sheet.id,
        });
        if (imported === null) {
          throw new Error(`Unknown or inaccessible sheet: ${sheet.id}`);
        }
        return {
          ...serializeSheetWithTabs(imported),
          import: {
            format: sourceFormat,
            filename: input.filename,
            sheetCount: parsed.tabs.length,
            rowCount: parsed.rowCount,
            columnCount: parsed.columnCount,
            populatedCellCount: parsed.populatedCellCount,
          },
        };
      },
    }),
    defineTool<z.output<typeof importOdsSchema>, unknown>({
      id: "sheets.import-ods",
      description: "Import an ODS workbook into a native Helix spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(importOdsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const parsed = await parseOdsForImport(input.contentBase64);
        const title = input.title ?? titleFromWorkbookFilename(input.filename);
        const sheet = await store.createSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title,
          tabNames: parsed.tabs.map((tab) => tab.name),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject({
            ...input.metadata,
            importedFrom: "ods",
            sourceFilename: input.filename,
          }),
        });
        for (const [index, importedTab] of parsed.tabs.entries()) {
          const tab = sheet.tabs[index];
          if (tab === undefined || importedTab.edits.length === 0) {
            continue;
          }
          await store.updateCells({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            tabId: tab.id,
            edits: importedTab.edits,
          });
        }
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "sheets.sheet",
          resourceId: sheet.id,
          derivation: { content: title, scanContent: true },
        });
        const imported = await store.getSheet({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          sheetId: sheet.id,
        });
        if (imported === null) {
          throw new Error(`Unknown or inaccessible sheet: ${sheet.id}`);
        }
        return {
          ...serializeSheetWithTabs(imported),
          import: {
            format: "ods",
            filename: input.filename,
            sheetCount: parsed.tabs.length,
            rowCount: parsed.rowCount,
            columnCount: parsed.columnCount,
            populatedCellCount: parsed.populatedCellCount,
          },
        };
      },
    }),
    defineTool<z.output<typeof exportSchema>, unknown>({
      id: "sheets.export",
      description: "Export a native Helix spreadsheet as CSV, TSV, XLSX, or ODS.",
      permission: "sheets.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(exportSchema, genericObjectJsonSchema),
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
        const tabs = await sheetTabsWithCells(sheet, store, {
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
        });
        const comments =
          input.format === "xlsx" || input.format === "ods"
            ? await store.listComments({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                sheetId: sheet.id,
                status: "all",
              })
            : [];
        const exported = await exportSheetWorkbook(
          sheet,
          tabs,
          comments,
          input.format,
          input.tabId,
        );
        return {
          sheetId: sheet.id,
          format: input.format,
          filename: exported.filename,
          mimeType: exported.mimeType,
          byteSize: exported.buffer.byteLength,
          contentBase64: exported.buffer.toString("base64"),
          metadata: exported.metadata,
        };
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
          window: input.window,
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
            window: input.window,
          }),
        ),
    }),
    defineTool<z.output<typeof rangeSortSchema>, unknown>({
      id: "sheets.range.sort",
      description: "Sort a rectangular cell range by its first column.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(rangeSortSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeTabWithCells(
          await store.sortRange({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            tabId: input.tabId,
            range: input.range,
            direction: input.direction,
            window: input.window,
          }),
        ),
    }),
    defineTool<z.output<typeof createCommentSchema>, unknown>({
      id: "sheets.comment.create",
      description: "Create a selected cell or range comment on a spreadsheet.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeComment(
          await store.createComment({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            sheetId: input.sheetId,
            ...(input.parentCommentId === undefined
              ? {}
              : { parentCommentId: input.parentCommentId }),
            body: input.body,
            anchor: toJsonObject(input.anchor),
            metadata: toJsonObject(input.metadata),
          }),
        ),
    }),
    defineTool<z.output<typeof listCommentsSchema>, unknown>({
      id: "sheets.comment.list",
      description: "List comments on a spreadsheet.",
      permission: "sheets.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listCommentsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        comments: (
          await store.listComments({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            sheetId: input.sheetId,
            status: input.status,
          })
        ).map(serializeComment),
      }),
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "sheets.comment.resolve",
      description: "Resolve a spreadsheet comment.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = await store.resolveComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        });
        if (comment === null) {
          throw new Error(`Unknown spreadsheet comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "sheets.comment.reopen",
      description: "Reopen a resolved spreadsheet comment.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = await store.reopenComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        });
        if (comment === null) {
          throw new Error(`Unknown spreadsheet comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof updateCommentSchema>, unknown>({
      id: "sheets.comment.update",
      description: "Update a spreadsheet comment body.",
      permission: "sheets.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = await store.updateComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
          body: input.body,
        });
        if (comment === null) {
          throw new Error(`Unknown spreadsheet comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "sheets.comment.delete",
      description: "Delete a spreadsheet comment.",
      permission: "sheets.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = await store.deleteComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        });
        if (comment === null) {
          throw new Error(`Unknown spreadsheet comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
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

function serializeVersion(version: SheetVersionRecord) {
  return {
    id: version.id,
    orgId: version.orgId,
    sheetId: version.sheetId,
    versionNumber: version.versionNumber,
    mimeType: version.mimeType,
    byteSize: version.byteSize,
    sha256: version.sha256,
    metadata: version.metadata,
    createdByActorId: version.createdByActorId,
    createdAt: version.createdAt.toISOString(),
  };
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
    formula: cell.formula,
    calcValue: cell.calcValue,
    dependencies: cell.dependencies,
    formulaError: cell.formulaError,
    format: cell.format,
    createdAt: cell.createdAt.toISOString(),
    updatedAt: cell.updatedAt.toISOString(),
  };
}

function serializeTabWithCells(tab: SheetTabWithCells) {
  return {
    ...serializeTab(tab),
    cells: tab.cells.map(serializeCell),
  };
}

function serializeComment(comment: SheetCommentRecord | SheetCommentListItem) {
  return {
    ...comment,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt?.toISOString() ?? null,
  };
}

async function sheetTabsWithCells(
  sheet: SheetWithTabs,
  store: SheetsStore,
  actor: { readonly orgId: string; readonly actorId: string },
): Promise<readonly SheetTabWithCells[]> {
  const tabs: SheetTabWithCells[] = [];
  for (const tab of sheet.tabs) {
    const tabWithCells = await store.getTabCells({
      orgId: actor.orgId,
      actorId: actor.actorId,
      tabId: tab.id,
    });
    if (tabWithCells !== null) {
      tabs.push(tabWithCells);
    }
  }
  return tabs;
}

async function exportSheetWorkbook(
  sheet: SheetWithTabs,
  tabs: readonly SheetTabWithCells[],
  comments: readonly SheetCommentListItem[],
  format: "csv" | "tsv" | "xlsx" | "ods",
  tabId: string | undefined,
): Promise<{
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
  readonly metadata: JsonObject;
}> {
  if (format === "xlsx") {
    return exportSheetWorkbookToXlsx(sheet, tabs, comments);
  }
  if (format === "ods") {
    return exportSheetWorkbookToOds(sheet, tabs, comments);
  }
  const tab = selectedExportTab(tabs, tabId);
  const delimiter = format === "csv" ? "," : "\t";
  const text = delimitedTextFromCells(tab.cells, delimiter);
  return {
    filename: `${exportFilenameBase(sheet.title)}-${exportFilenameBase(tab.name)}.${format}`,
    mimeType: format === "csv" ? "text/csv" : "text/tab-separated-values",
    buffer: Buffer.from(text, "utf8"),
    metadata: toJsonObject({
      generatedBy: `helix.sheets.export.${format}`,
      tabId: tab.id,
      tabName: tab.name,
    }),
  };
}

function selectedExportTab(
  tabs: readonly SheetTabWithCells[],
  tabId: string | undefined,
): SheetTabWithCells {
  const tab = tabId === undefined ? tabs[0] : tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) {
    throw new Error("No matching spreadsheet tab is available for export.");
  }
  return tab;
}

function delimitedTextFromCells(cells: readonly SheetCellRecord[], delimiter: "," | "\t"): string {
  const bounds = sheetCellBounds(cells);
  if (bounds.rowCount === 0 || bounds.columnCount === 0) {
    return "";
  }
  const byKey = new Map(cells.map((cell) => [`${String(cell.row)}:${String(cell.col)}`, cell]));
  const rows: string[] = [];
  for (let row = 0; row < bounds.rowCount; row += 1) {
    const values: string[] = [];
    for (let col = 0; col < bounds.columnCount; col += 1) {
      const cell = byKey.get(`${String(row)}:${String(col)}`);
      values.push(delimitedCellValue(cell?.calcValue ?? cell?.value ?? "", delimiter));
    }
    rows.push(values.join(delimiter));
  }
  return rows.join("\n");
}

function delimitedCellValue(value: string, delimiter: "," | "\t"): string {
  if (delimiter === "\t") {
    return value.replace(/\r?\n/gu, " ");
  }
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

interface SheetExportComments {
  readonly byTab: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly count: number;
}

interface SheetNamedRangeExport {
  readonly id: string;
  readonly tabId: string;
  readonly name: string;
  readonly exportName: string;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

interface SheetValidationExportContext {
  readonly namedRangesById: ReadonlyMap<string, SheetNamedRangeExport>;
  readonly cellValuesByTab: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

function sheetExportComments(comments: readonly SheetCommentListItem[]): SheetExportComments {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const repliesByParent = new Map<string, SheetCommentListItem[]>();
  for (const comment of comments) {
    if (comment.parentCommentId === null) {
      continue;
    }
    const replies = repliesByParent.get(comment.parentCommentId) ?? [];
    replies.push(comment);
    repliesByParent.set(comment.parentCommentId, replies);
  }

  const mutableByTab = new Map<string, Map<string, string>>();
  let count = 0;
  for (const comment of comments) {
    if (comment.parentCommentId !== null && byId.has(comment.parentCommentId)) {
      continue;
    }
    const anchor = sheetExportCommentAnchor(comment);
    if (anchor === null) {
      continue;
    }
    const thread = [comment, ...(repliesByParent.get(comment.id) ?? [])];
    const note = sheetExportCommentNote(thread);
    const tabNotes = mutableByTab.get(anchor.tabId) ?? new Map<string, string>();
    const key = `${String(anchor.row)}:${String(anchor.col)}`;
    const existing = tabNotes.get(key);
    tabNotes.set(key, existing === undefined ? note : `${existing}\n\n---\n\n${note}`);
    mutableByTab.set(anchor.tabId, tabNotes);
    count += thread.length;
  }
  return { byTab: mutableByTab, count };
}

function sheetExportCommentAnchor(
  comment: SheetCommentListItem,
): { readonly tabId: string; readonly row: number; readonly col: number } | null {
  const anchor = comment.anchor;
  if (anchor["type"] !== "sheet-range" || anchor["deleted"] === true) {
    return null;
  }
  const tabId = anchor["tabId"];
  const range = anchor["range"];
  if (
    typeof tabId !== "string" ||
    typeof range !== "object" ||
    range === null ||
    Array.isArray(range)
  ) {
    return null;
  }
  const record = range as Record<string, unknown>;
  const startRow = sheetExportRangeCoordinate(record["startRow"]);
  const startCol = sheetExportRangeCoordinate(record["startCol"]);
  const endRow = sheetExportRangeCoordinate(record["endRow"]);
  const endCol = sheetExportRangeCoordinate(record["endCol"]);
  if (startRow === null || startCol === null || endRow === null || endCol === null) {
    return null;
  }
  return {
    tabId,
    row: Math.min(startRow, endRow),
    col: Math.min(startCol, endCol),
  };
}

function sheetExportRangeCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sheetExportCommentNote(comments: readonly SheetCommentListItem[]): string {
  return comments
    .map((comment, index) => {
      const prefix = index === 0 ? "" : "Reply: ";
      return `${prefix}${sheetExportCommentAuthor(comment)} [${comment.status}]: ${comment.body}`;
    })
    .join("\n");
}

function sheetExportCommentAuthor(comment: SheetCommentListItem): string {
  return comment.author?.displayName ?? comment.author?.email ?? comment.actorId ?? "Unknown";
}

function cellAddressFromCommentKey(
  key: string,
): { readonly row: number; readonly col: number } | null {
  const [rowText, colText] = key.split(":");
  const row = Number(rowText);
  const col = Number(colText);
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(col) || col < 0) {
    return null;
  }
  return { row, col };
}

function sheetValidationExportContext(
  sheet: SheetWithTabs,
  tabs: readonly SheetTabWithCells[],
): SheetValidationExportContext {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const usedNames = new Set<string>();
  const namedRangesById = new Map<string, SheetNamedRangeExport>();
  for (const range of sheetNamedRangesFromMetadata(sheet.metadata)) {
    if (!tabIds.has(range.tabId)) {
      continue;
    }
    const exportName = uniqueSheetExportName(range.name, usedNames);
    namedRangesById.set(range.id, { ...range, exportName });
  }
  const cellValuesByTab = new Map<string, ReadonlyMap<string, string>>();
  for (const tab of tabs) {
    cellValuesByTab.set(
      tab.id,
      new Map(tab.cells.map((cell) => [`${String(cell.row)}:${String(cell.col)}`, cell.value])),
    );
  }
  return { namedRangesById, cellValuesByTab };
}

function sheetNamedRangesFromMetadata(metadata: JsonObject): readonly SheetNamedRangeExport[] {
  const ranges = metadata["namedRanges"];
  if (!Array.isArray(ranges)) {
    return [];
  }
  return ranges.flatMap((range): SheetNamedRangeExport[] => {
    if (typeof range !== "object" || range === null || Array.isArray(range)) {
      return [];
    }
    const candidate = range as Record<string, unknown>;
    const cellRange = candidate["range"];
    if (
      typeof candidate["id"] !== "string" ||
      typeof candidate["tabId"] !== "string" ||
      typeof candidate["name"] !== "string" ||
      typeof cellRange !== "object" ||
      cellRange === null ||
      Array.isArray(cellRange)
    ) {
      return [];
    }
    const record = cellRange as Record<string, unknown>;
    const startRow = sheetExportRangeCoordinate(record["startRow"]);
    const startCol = sheetExportRangeCoordinate(record["startCol"]);
    const endRow = sheetExportRangeCoordinate(record["endRow"]);
    const endCol = sheetExportRangeCoordinate(record["endCol"]);
    if (startRow === null || startCol === null || endRow === null || endCol === null) {
      return [];
    }
    return [
      {
        id: candidate["id"],
        tabId: candidate["tabId"],
        name: candidate["name"],
        exportName: candidate["name"],
        range: { startRow, startCol, endRow, endCol },
      },
    ];
  });
}

function uniqueSheetExportName(name: string, usedNames: Set<string>): string {
  const base = sanitizeSheetExportName(name);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}_${String(suffix)}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function sanitizeSheetExportName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^A-Za-z0-9_.]/gu, "_")
    .replace(/^[^A-Za-z_]+/u, "");
  return sanitized.length === 0 || /^[A-Za-z]{1,3}[1-9][0-9]*$/u.test(sanitized)
    ? "Named_Range"
    : sanitized.slice(0, 240);
}

async function exportSheetWorkbookToXlsx(
  sheet: SheetWithTabs,
  tabs: readonly SheetTabWithCells[],
  comments: readonly SheetCommentListItem[],
): Promise<{
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
  readonly metadata: JsonObject;
}> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const exportComments = sheetExportComments(comments);
  const validationContext = sheetValidationExportContext(sheet, tabs);
  let conditionalFormatRuleCount = 0;
  workbook.creator = "Helix";
  workbook.created = new Date("1970-01-01T00:00:00.000Z");
  workbook.modified = new Date("1970-01-01T00:00:00.000Z");
  const tabNameById = new Map(tabs.map((tab) => [tab.id, xlsxWorksheetName(tab.name)]));
  for (const namedRange of validationContext.namedRangesById.values()) {
    const tabName = tabNameById.get(namedRange.tabId);
    if (tabName !== undefined) {
      workbook.definedNames.add(
        xlsxDefinedNameLocation(tabName, namedRange),
        namedRange.exportName,
      );
    }
  }
  for (const tab of tabs) {
    const worksheet = workbook.addWorksheet(xlsxWorksheetName(tab.name));
    for (const cell of tab.cells) {
      const xlsxCell = worksheet.getCell(cell.row + 1, cell.col + 1);
      xlsxCell.value = xlsxExportCellValue(cell);
      const numFmt = xlsxExportNumberFormat(cell.format);
      if (numFmt !== undefined) {
        xlsxCell.numFmt = numFmt;
      }
      xlsxApplyCellFormat(xlsxCell, cell, validationContext);
    }
    conditionalFormatRuleCount += xlsxApplyConditionalFormatting(worksheet, tab.cells);
    for (const [key, note] of exportComments.byTab.get(tab.id) ?? []) {
      const address = cellAddressFromCommentKey(key);
      if (address !== null) {
        worksheet.getCell(address.row + 1, address.col + 1).note = note;
      }
    }
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: `${exportFilenameBase(sheet.title)}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
    metadata: toJsonObject({
      generatedBy: "helix.sheets.export.xlsx",
      sheetCount: tabs.length,
      populatedCellCount: tabs.reduce((total, tab) => total + tab.cells.length, 0),
      commentCount: exportComments.count,
      namedRangeCount: validationContext.namedRangesById.size,
      conditionalFormatRuleCount,
    }),
  };
}

function xlsxExportCellValue(cell: SheetCellRecord): CellValue {
  if (cell.value.trimStart().startsWith("=")) {
    const result = xlsxFormulaResult(cell.calcValue);
    return {
      formula: cell.value.trimStart().slice(1),
      ...(result === undefined ? {} : { result }),
    };
  }
  const numeric = numericCellValue(cell.value);
  const linkUrl = normalizedSafeSheetLinkUrl(cell.format["linkUrl"]);
  if (linkUrl !== undefined) {
    return { text: cell.value, hyperlink: linkUrl };
  }
  return numeric ?? cell.value;
}

function xlsxFormulaResult(value: string | null): string | number | undefined {
  if (value === null || value.length === 0 || value.startsWith("#")) {
    return undefined;
  }
  return numericCellValue(value) ?? value;
}

function numericCellValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(trimmed)) {
    return null;
  }
  return Number(trimmed.replace(/,/gu, ""));
}

function normalizedSafeSheetLinkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function xlsxExportNumberFormat(format: JsonObject): string | undefined {
  const custom = format["customNumberFormat"];
  if (format["numberFormat"] === "custom" && typeof custom === "string") {
    return SUPPORTED_CUSTOM_NUMBER_FORMAT_SET.has(custom) ? custom : undefined;
  }
  if (format["numberFormat"] === "currency") {
    return "$#,##0.00";
  }
  if (format["numberFormat"] === "percent") {
    return "0.00%";
  }
  if (format["numberFormat"] === "date") {
    return "m/d/yyyy";
  }
  if (format["numberFormat"] === "number") {
    return "#,##0.00";
  }
  return undefined;
}

function xlsxApplyCellFormat(
  cell: Cell,
  sheetCell: SheetCellRecord,
  validationContext: SheetValidationExportContext,
): void {
  const fillArgb = xlsxArgbColor(sheetCell.format["fillColor"]);
  if (fillArgb !== undefined) {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: fillArgb },
    } satisfies Fill;
  }

  const font: Cell["font"] = {};
  if (sheetCell.format["bold"] === true) {
    font.bold = true;
  }
  if (sheetCell.format["italic"] === true) {
    font.italic = true;
  }
  const textArgb = xlsxArgbColor(sheetCell.format["textColor"]);
  if (textArgb !== undefined) {
    font.color = { argb: textArgb };
  }
  if (Object.keys(font).length > 0) {
    cell.font = font;
  }

  const border = xlsxCellBorder(sheetCell.format["borders"]);
  if (border !== undefined) {
    cell.border = border;
  }

  const validation = xlsxDataValidation(sheetCell.format, validationContext);
  if (validation !== undefined) {
    cell.dataValidation = validation;
  }
}

function xlsxApplyConditionalFormatting(
  worksheet: Worksheet,
  cells: readonly SheetCellRecord[],
): number {
  let count = 0;
  for (const cell of cells) {
    const rule = xlsxConditionalFormattingRule(cell, count + 1);
    if (rule === undefined) {
      continue;
    }
    worksheet.addConditionalFormatting({
      ref: cellA1(cell.row, cell.col),
      rules: [rule],
    });
    count += 1;
  }
  return count;
}

function xlsxConditionalFormattingRule(
  cell: SheetCellRecord,
  priority: number,
): ConditionalFormattingRule | undefined {
  const conditionalFormat = cell.format["conditionalFormat"];
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return undefined;
  }
  const rule = conditionalFormat as Record<string, unknown>;
  const style = xlsxConditionalFormattingStyle(rule);
  const type = rule["type"];
  if (type === "greaterThan100" || rule["operator"] === "greaterThan") {
    return xlsxCellIsConditionalRule({
      operator: "greaterThan",
      formula: String(typeof rule["value"] === "number" ? rule["value"] : 100),
      priority,
      style,
    });
  }
  if (type === "lessThanZero" || rule["operator"] === "lessThan") {
    return xlsxCellIsConditionalRule({
      operator: "lessThan",
      formula: String(typeof rule["value"] === "number" ? rule["value"] : 0),
      priority,
      style,
    });
  }
  if (type === "customFormula") {
    const formula =
      typeof rule["formula"] === "string"
        ? xlsxConditionalFormula(rule["formula"], cell.row, cell.col)
        : "";
    return formula.length === 0
      ? undefined
      : {
          type: "expression",
          priority,
          formulae: [formula],
          style,
        };
  }
  if (type === "textContains" || rule["operator"] === "containsText") {
    const text = typeof rule["text"] === "string" ? rule["text"].trim() : "";
    if (text.length === 0) {
      return undefined;
    }
    return {
      type: "expression",
      priority,
      formulae: [`ISNUMBER(SEARCH("${xlsxFormulaString(text)}",${cellA1(cell.row, cell.col)}))`],
      style,
    };
  }
  return undefined;
}

function xlsxCellIsConditionalRule(input: {
  readonly operator: CellIsOperators;
  readonly formula: string;
  readonly priority: number;
  readonly style: Partial<Style>;
}): ConditionalFormattingRule {
  return {
    type: "cellIs",
    operator: input.operator,
    priority: input.priority,
    formulae: [input.formula],
    style: input.style,
  };
}

function xlsxConditionalFormattingStyle(rule: Record<string, unknown>): Partial<Style> {
  const fillArgb = xlsxArgbColor(rule["fillColor"]);
  const textArgb = xlsxArgbColor(rule["textColor"]);
  return {
    ...(fillArgb === undefined
      ? {}
      : { fill: { type: "pattern", pattern: "solid", fgColor: { argb: fillArgb } } }),
    ...(textArgb === undefined ? {} : { font: { color: { argb: textArgb } } }),
  };
}

function xlsxConditionalFormula(formula: string, row: number, col: number): string {
  return formula
    .trim()
    .replace(/^=/u, "")
    .replace(/\bVALUE\b/giu, cellA1(row, col));
}

function xlsxFormulaString(value: string): string {
  return value.replace(/"/gu, '""');
}

function xlsxArgbColor(value: unknown): string | undefined {
  const normalized = normalizedHexColor(value);
  return normalized === undefined ? undefined : `FF${normalized.slice(1).toUpperCase()}`;
}

function normalizedHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return /^#[0-9a-fA-F]{6}$/u.test(normalized) ? normalized.toLowerCase() : undefined;
}

function conditionalExportStyle(cell: SheetCellRecord): {
  readonly fillColor?: string;
  readonly textColor?: string;
} {
  const conditionalFormat = cell.format["conditionalFormat"];
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return {};
  }
  const rule = conditionalFormat as Record<string, unknown>;
  if (!conditionalExportRuleMatches(rule, cell.calcValue ?? cell.value)) {
    return {};
  }
  const fillColor = normalizedHexColor(rule["fillColor"]);
  const textColor = normalizedHexColor(rule["textColor"]);
  return {
    ...(fillColor === undefined ? {} : { fillColor }),
    ...(textColor === undefined ? {} : { textColor }),
  };
}

function conditionalExportRuleMatches(rule: Record<string, unknown>, value: string): boolean {
  const type = rule["type"];
  if (type === "greaterThan100" || rule["operator"] === "greaterThan") {
    const threshold = typeof rule["value"] === "number" ? rule["value"] : 100;
    const numericValue = Number(value.trim().replace(/,/gu, ""));
    return Number.isFinite(numericValue) && numericValue > threshold;
  }
  if (type === "lessThanZero" || rule["operator"] === "lessThan") {
    const threshold = typeof rule["value"] === "number" ? rule["value"] : 0;
    const numericValue = Number(value.trim().replace(/,/gu, ""));
    return Number.isFinite(numericValue) && numericValue < threshold;
  }
  if (type === "customFormula") {
    const formula = typeof rule["formula"] === "string" ? rule["formula"] : "";
    return conditionalExportFormulaMatches(formula, value);
  }
  if (type === "textContains" || rule["operator"] === "containsText") {
    const text = typeof rule["text"] === "string" ? rule["text"].trim() : "";
    return text.length > 0 && value.toLocaleLowerCase().includes(text.toLocaleLowerCase());
  }
  return false;
}

function conditionalExportFormulaMatches(formula: string, value: string): boolean {
  const expression = formula.trim().replace(/^=/u, "").trim();
  if (expression.length === 0) {
    return false;
  }
  const comparison = expression.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/u);
  if (comparison === null) {
    return conditionalExportTermTruthy(conditionalExportFormulaTermValue(expression, value));
  }
  const left = conditionalExportFormulaTermValue(comparison[1]?.trim() ?? "", value);
  const operator = comparison[2] ?? "";
  const right = conditionalExportFormulaTermValue(comparison[3]?.trim() ?? "", value);
  return compareConditionalExportTerms(left, operator, right);
}

function conditionalExportFormulaTermValue(term: string, value: string): string | number | boolean {
  const normalized = term.trim();
  if (/^VALUE$/iu.test(normalized)) {
    return value.trim();
  }
  if (/^TRUE$/iu.test(normalized)) {
    return true;
  }
  if (/^FALSE$/iu.test(normalized)) {
    return false;
  }
  const quoted = normalized.match(/^"([^"]*)"$/u);
  if (quoted !== null) {
    return quoted[1] ?? "";
  }
  const numeric = Number(normalized.replace(/,/gu, ""));
  if (Number.isFinite(numeric) && normalized.length > 0) {
    return numeric;
  }
  return normalized;
}

function conditionalExportTermTruthy(value: string | number | boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const numeric = Number(value.replace(/,/gu, ""));
  if (Number.isFinite(numeric) && value.trim().length > 0) {
    return numeric !== 0;
  }
  return value.trim().length > 0;
}

function compareConditionalExportTerms(
  left: string | number | boolean,
  operator: string,
  right: string | number | boolean,
): boolean {
  const leftNumeric = typeof left === "number" ? left : Number(String(left).replace(/,/gu, ""));
  const rightNumeric = typeof right === "number" ? right : Number(String(right).replace(/,/gu, ""));
  const numericComparison =
    Number.isFinite(leftNumeric) &&
    Number.isFinite(rightNumeric) &&
    String(left).trim().length > 0 &&
    String(right).trim().length > 0;
  const leftValue = numericComparison ? leftNumeric : String(left).toLowerCase();
  const rightValue = numericComparison ? rightNumeric : String(right).toLowerCase();

  if (operator === ">") return leftValue > rightValue;
  if (operator === "<") return leftValue < rightValue;
  if (operator === ">=") return leftValue >= rightValue;
  if (operator === "<=") return leftValue <= rightValue;
  if (operator === "!=" || operator === "<>") return leftValue !== rightValue;
  return leftValue === rightValue;
}

function xlsxCellBorder(value: unknown): Cell["border"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const borders = value as Record<string, unknown>;
  const side = { style: "thin", color: { argb: "FF111827" } } as const;
  const output: Cell["border"] = {};
  if (borders["top"] === true) output.top = side;
  if (borders["right"] === true) output.right = side;
  if (borders["bottom"] === true) output.bottom = side;
  if (borders["left"] === true) output.left = side;
  return Object.keys(output).length > 0 ? output : undefined;
}

function xlsxDataValidation(
  format: JsonObject,
  context: SheetValidationExportContext,
): DataValidation | undefined {
  const namedRangeValidation = namedRangeListValidation(format, context);
  if (namedRangeValidation !== undefined) {
    const { namedRange, mode } = namedRangeValidation;
    return {
      type: "list",
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: mode === "warn" ? "warning" : "error",
      errorTitle: "Invalid value",
      error: `Choose a value from ${namedRange.name}.`,
      formulae: [namedRange.exportName],
    };
  }
  const validation = manualListValidation(format);
  if (validation === undefined) {
    return undefined;
  }
  const { choices, mode } = validation;
  return {
    type: "list",
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: mode === "warn" ? "warning" : "error",
    errorTitle: "Invalid value",
    error: `Choose one of: ${choices.join(", ")}`,
    formulae: [`"${choices.map((choice) => choice.replace(/"/gu, '""')).join(",")}"`],
  };
}

function xlsxDefinedNameLocation(tabName: string, namedRange: SheetNamedRangeExport): string {
  const top = Math.min(namedRange.range.startRow, namedRange.range.endRow);
  const bottom = Math.max(namedRange.range.startRow, namedRange.range.endRow);
  const left = Math.min(namedRange.range.startCol, namedRange.range.endCol);
  const right = Math.max(namedRange.range.startCol, namedRange.range.endCol);
  const start = `$${columnLetter(left)}$${String(top + 1)}`;
  const end = `$${columnLetter(right)}$${String(bottom + 1)}`;
  return `'${tabName.replace(/'/gu, "''")}'!${start}:${end}`;
}

interface ManualListValidation {
  readonly choices: readonly string[];
  readonly mode: "warn" | "reject";
}

interface NamedRangeListValidation {
  readonly namedRange: SheetNamedRangeExport;
  readonly mode: "warn" | "reject";
}

interface OdsCellStyle {
  readonly fillColor?: string;
  readonly textColor?: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly borders: {
    readonly top: boolean;
    readonly right: boolean;
    readonly bottom: boolean;
    readonly left: boolean;
  };
  readonly conditional?: OdsConditionalStyleMap;
}

interface OdsConditionalStyleMap {
  readonly condition: string;
  readonly applyStyleName: string;
}

interface OdsConditionalStyle {
  readonly fillColor?: string;
  readonly textColor?: string;
}

interface OdsExportContext {
  readonly styles: ReadonlyMap<string, string>;
  readonly styleXml: readonly string[];
  readonly conditionalStyles: ReadonlyMap<string, string>;
  readonly validations: ReadonlyMap<string, string>;
  readonly validationXml: readonly string[];
}

function manualListValidation(format: JsonObject): ManualListValidation | undefined {
  const dataValidation = format["dataValidation"];
  if (
    typeof dataValidation !== "object" ||
    dataValidation === null ||
    Array.isArray(dataValidation)
  ) {
    return undefined;
  }
  const validation = dataValidation as Record<string, unknown>;
  if (validation["type"] !== "list" || validation["namedRangeId"] !== undefined) {
    return undefined;
  }
  const choicesValue = validation["choices"];
  if (!Array.isArray(choicesValue)) {
    return undefined;
  }
  const choices = choicesValue
    .filter((choice): choice is string => typeof choice === "string")
    .map((choice) => choice.trim())
    .filter((choice) => choice.length > 0)
    .slice(0, 100);
  if (choices.length === 0) {
    return undefined;
  }
  return {
    choices,
    mode: validation["mode"] === "warn" ? "warn" : "reject",
  };
}

function namedRangeListValidation(
  format: JsonObject,
  context: SheetValidationExportContext,
): NamedRangeListValidation | undefined {
  const dataValidation = format["dataValidation"];
  if (
    typeof dataValidation !== "object" ||
    dataValidation === null ||
    Array.isArray(dataValidation)
  ) {
    return undefined;
  }
  const validation = dataValidation as Record<string, unknown>;
  const namedRangeId = validation["namedRangeId"];
  if (validation["type"] !== "list" || typeof namedRangeId !== "string") {
    return undefined;
  }
  const namedRange = context.namedRangesById.get(namedRangeId);
  if (namedRange === undefined) {
    return undefined;
  }
  return {
    namedRange,
    mode: validation["mode"] === "warn" ? "warn" : "reject",
  };
}

function namedRangeListValidationAsChoices(
  format: JsonObject,
  context: SheetValidationExportContext,
): ManualListValidation | undefined {
  const validation = namedRangeListValidation(format, context);
  if (validation === undefined) {
    return undefined;
  }
  const choices = sheetNamedRangeChoices(validation.namedRange, context);
  return choices.length === 0 ? undefined : { choices, mode: validation.mode };
}

function sheetNamedRangeChoices(
  namedRange: SheetNamedRangeExport,
  context: SheetValidationExportContext,
): readonly string[] {
  const values = context.cellValuesByTab.get(namedRange.tabId);
  if (values === undefined) {
    return [];
  }
  const top = Math.min(namedRange.range.startRow, namedRange.range.endRow);
  const bottom = Math.max(namedRange.range.startRow, namedRange.range.endRow);
  const left = Math.min(namedRange.range.startCol, namedRange.range.endCol);
  const right = Math.max(namedRange.range.startCol, namedRange.range.endCol);
  const choices: string[] = [];
  const seen = new Set<string>();
  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      const value = values.get(`${String(row)}:${String(col)}`)?.trim();
      if (value !== undefined && value.length > 0 && !seen.has(value)) {
        seen.add(value);
        choices.push(value);
      }
    }
  }
  return choices.slice(0, 100);
}

async function exportSheetWorkbookToOds(
  sheet: SheetWithTabs,
  tabs: readonly SheetTabWithCells[],
  comments: readonly SheetCommentListItem[],
): Promise<{
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
  readonly metadata: JsonObject;
}> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", {
    compression: "STORE",
  });
  const exportComments = sheetExportComments(comments);
  const validationContext = sheetValidationExportContext(sheet, tabs);
  zip.file("content.xml", odsContentXml(tabs, exportComments, validationContext));
  zip.file("meta.xml", odsMetaXml(sheet.title));
  zip.file("styles.xml", odsStylesXml());
  zip.file("META-INF/manifest.xml", odsManifestXml());
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.oasis.opendocument.spreadsheet",
  });
  return {
    filename: `${exportFilenameBase(sheet.title)}.ods`,
    mimeType: "application/vnd.oasis.opendocument.spreadsheet",
    buffer,
    metadata: toJsonObject({
      generatedBy: "helix.sheets.export.ods",
      sheetCount: tabs.length,
      populatedCellCount: tabs.reduce((total, tab) => total + tab.cells.length, 0),
      commentCount: exportComments.count,
      namedRangeCount: validationContext.namedRangesById.size,
    }),
  };
}

function odsContentXml(
  tabs: readonly SheetTabWithCells[],
  exportComments: SheetExportComments,
  validationContext: SheetValidationExportContext,
): string {
  const context = buildOdsExportContext(tabs, validationContext);
  const automaticStyles =
    context.styleXml.length === 0
      ? ""
      : `  <office:automatic-styles>\n${context.styleXml.join("\n")}\n  </office:automatic-styles>\n`;
  const validations =
    context.validationXml.length === 0
      ? ""
      : `      <table:content-validations>\n${context.validationXml.join(
          "\n",
        )}\n      </table:content-validations>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
${automaticStyles}  <office:body>
    <office:spreadsheet>
${validations}${tabs.map((tab) => odsTableXml(tab, context, exportComments, validationContext)).join("\n")}
    </office:spreadsheet>
  </office:body>
</office:document-content>`;
}

function odsTableXml(
  tab: SheetTabWithCells,
  context: OdsExportContext,
  exportComments: SheetExportComments,
  validationContext: SheetValidationExportContext,
): string {
  const commentNotes = exportComments.byTab.get(tab.id) ?? new Map<string, string>();
  const bounds = sheetCellBoundsWithComments(tab.cells, commentNotes);
  const byKey = new Map(tab.cells.map((cell) => [`${String(cell.row)}:${String(cell.col)}`, cell]));
  const rows: string[] = [];
  for (let row = 0; row < bounds.rowCount; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < bounds.columnCount; col += 1) {
      const key = `${String(row)}:${String(col)}`;
      cells.push(odsCellXml(byKey.get(key), context, validationContext, commentNotes.get(key)));
    }
    rows.push(`      <table:table-row>${cells.join("")}</table:table-row>`);
  }
  return `      <table:table table:name="${xmlAttribute(tab.name)}">
${rows.join("\n")}
      </table:table>`;
}

function odsCellXml(
  cell: SheetCellRecord | undefined,
  context: OdsExportContext,
  validationContext: SheetValidationExportContext,
  commentNote: string | undefined,
): string {
  const attributes = odsCellAttributes(cell, context, validationContext);
  const annotation = commentNote === undefined ? "" : odsAnnotationXml(commentNote);
  if (cell === undefined || cell.value.length === 0) {
    return annotation.length === 0
      ? `<table:table-cell${attributes}/>`
      : `<table:table-cell${attributes}>${annotation}</table:table-cell>`;
  }
  if (cell.value.trimStart().startsWith("=")) {
    const result = cell.calcValue ?? "";
    const numeric = numericCellValue(result);
    return `<table:table-cell${attributes} table:formula="of:=${xmlAttribute(
      odsFormulaFromHelixFormula(cell.value),
    )}" office:value-type="${numeric === null ? "string" : "float"}"${
      numeric === null ? "" : ` office:value="${String(numeric)}"`
    }>${annotation}<text:p>${xmlText(
      numeric === null ? result : String(numeric),
    )}</text:p></table:table-cell>`;
  }
  const numeric = numericCellValue(cell.value);
  if (numeric !== null) {
    return `<table:table-cell${attributes} office:value-type="float" office:value="${String(
      numeric,
    )}">${annotation}${odsCellTextParagraph(cell.value, cell.format)}</table:table-cell>`;
  }
  return `<table:table-cell${attributes} office:value-type="string">${annotation}${odsCellTextParagraph(
    cell.value,
    cell.format,
  )}</table:table-cell>`;
}

function odsCellTextParagraph(value: string, format: JsonObject): string {
  const linkUrl = normalizedSafeSheetLinkUrl(format["linkUrl"]);
  return linkUrl === undefined
    ? `<text:p>${xmlText(value)}</text:p>`
    : `<text:p><text:a xlink:href="${xmlAttribute(linkUrl)}">${xmlText(value)}</text:a></text:p>`;
}

function buildOdsExportContext(
  tabs: readonly SheetTabWithCells[],
  validationContext: SheetValidationExportContext,
): OdsExportContext {
  const styles = new Map<string, string>();
  const styleXml: string[] = [];
  const conditionalStyles = new Map<string, string>();
  const validations = new Map<string, string>();
  const validationXml: string[] = [];
  for (const tab of tabs) {
    for (const cell of tab.cells) {
      const conditional = odsConditionalStyle(cell);
      let conditionalStyleName: string | undefined;
      if (conditional !== undefined) {
        const conditionalKey = JSON.stringify(conditional.style);
        conditionalStyleName = conditionalStyles.get(conditionalKey);
        if (conditionalStyleName === undefined) {
          conditionalStyleName = `cf${String(conditionalStyles.size + 1)}`;
          conditionalStyles.set(conditionalKey, conditionalStyleName);
          styleXml.push(odsConditionalCellStyleXml(conditionalStyleName, conditional.style));
        }
      }
      const style = odsCellStyle(cell, conditionalStyleName);
      if (style !== undefined) {
        const key = JSON.stringify(style);
        if (!styles.has(key)) {
          const name = `ce${String(styles.size + 1)}`;
          styles.set(key, name);
          styleXml.push(odsCellStyleXml(name, style));
        }
      }
      const validation =
        manualListValidation(cell.format) ??
        namedRangeListValidationAsChoices(cell.format, validationContext);
      if (validation !== undefined) {
        const key = JSON.stringify(validation);
        if (!validations.has(key)) {
          const name = `dv${String(validations.size + 1)}`;
          validations.set(key, name);
          validationXml.push(odsContentValidationXml(name, validation));
        }
      }
    }
  }
  return { styles, styleXml, conditionalStyles, validations, validationXml };
}

function odsCellAttributes(
  cell: SheetCellRecord | undefined,
  context: OdsExportContext,
  validationContext: SheetValidationExportContext,
): string {
  if (cell === undefined) {
    return "";
  }
  const attributes: string[] = [];
  const conditional = odsConditionalStyle(cell);
  const conditionalStyleName =
    conditional === undefined
      ? undefined
      : context.conditionalStyles.get(JSON.stringify(conditional.style));
  const style = odsCellStyle(cell, conditionalStyleName);
  if (style !== undefined) {
    const name = context.styles.get(JSON.stringify(style));
    if (name !== undefined) {
      attributes.push(`table:style-name="${name}"`);
    }
  }
  const validation =
    manualListValidation(cell.format) ??
    namedRangeListValidationAsChoices(cell.format, validationContext);
  if (validation !== undefined) {
    const name = context.validations.get(JSON.stringify(validation));
    if (name !== undefined) {
      attributes.push(`table:validation-name="${name}"`);
    }
  }
  return attributes.length === 0 ? "" : ` ${attributes.join(" ")}`;
}

function odsCellStyle(
  cell: SheetCellRecord,
  conditionalStyleName: string | undefined,
): OdsCellStyle | undefined {
  const { format } = cell;
  const conditionalStyle = conditionalStyleName === undefined ? conditionalExportStyle(cell) : {};
  const conditional = odsConditionalStyle(cell);
  const borders = odsCellBorders(format["borders"]);
  const fillColor = normalizedHexColor(conditionalStyle.fillColor ?? format["fillColor"]);
  const textColor = normalizedHexColor(conditionalStyle.textColor ?? format["textColor"]);
  const style: OdsCellStyle = {
    ...(fillColor === undefined ? {} : { fillColor }),
    ...(textColor === undefined ? {} : { textColor }),
    bold: format["bold"] === true,
    italic: format["italic"] === true,
    borders,
    ...(conditionalStyleName === undefined || conditional === undefined
      ? {}
      : {
          conditional: {
            condition: conditional.condition,
            applyStyleName: conditionalStyleName,
          },
        }),
  };
  const hasStyle =
    style.fillColor !== undefined ||
    style.textColor !== undefined ||
    style.bold ||
    style.italic ||
    style.conditional !== undefined ||
    borders.top ||
    borders.right ||
    borders.bottom ||
    borders.left;
  return hasStyle ? style : undefined;
}

function odsCellBorders(value: unknown): OdsCellStyle["borders"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { top: false, right: false, bottom: false, left: false };
  }
  const borders = value as Record<string, unknown>;
  return {
    top: borders["top"] === true,
    right: borders["right"] === true,
    bottom: borders["bottom"] === true,
    left: borders["left"] === true,
  };
}

function odsConditionalStyle(
  cell: SheetCellRecord,
): { readonly condition: string; readonly style: OdsConditionalStyle } | undefined {
  const conditionalFormat = cell.format["conditionalFormat"];
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return undefined;
  }
  const rule = conditionalFormat as Record<string, unknown>;
  const condition = odsConditionalCondition(rule);
  if (condition === undefined) {
    return undefined;
  }
  const fillColor = normalizedHexColor(rule["fillColor"]);
  const textColor = normalizedHexColor(rule["textColor"]);
  if (fillColor === undefined && textColor === undefined) {
    return undefined;
  }
  return {
    condition,
    style: {
      ...(fillColor === undefined ? {} : { fillColor }),
      ...(textColor === undefined ? {} : { textColor }),
    },
  };
}

function odsConditionalCondition(rule: Record<string, unknown>): string | undefined {
  const type = rule["type"];
  if (type === "greaterThan100" || rule["operator"] === "greaterThan") {
    const threshold = typeof rule["value"] === "number" ? rule["value"] : 100;
    return `cell-content()>${String(threshold)}`;
  }
  if (type === "lessThanZero" || rule["operator"] === "lessThan") {
    const threshold = typeof rule["value"] === "number" ? rule["value"] : 0;
    return `cell-content()<${String(threshold)}`;
  }
  if (type === "textContains" || rule["operator"] === "containsText") {
    const text = typeof rule["text"] === "string" ? rule["text"].trim() : "";
    return text.length === 0
      ? undefined
      : `is-true-formula(ISNUMBER(SEARCH("${odsFormulaString(text)}";cell-content())))`;
  }
  if (type !== "customFormula" || typeof rule["formula"] !== "string") {
    return undefined;
  }
  const formula = odsConditionalFormula(rule["formula"]);
  return formula.length === 0 ? undefined : `is-true-formula(${formula})`;
}

function odsConditionalFormula(formula: string): string {
  return formula
    .trim()
    .replace(/^=/u, "")
    .replace(/\bVALUE\b/giu, "cell-content()");
}

function odsFormulaString(value: string): string {
  return value.replace(/"/gu, '""');
}

function odsCellStyleXml(name: string, style: OdsCellStyle): string {
  const cellProperties: string[] = [];
  if (style.fillColor !== undefined) {
    cellProperties.push(`fo:background-color="${style.fillColor}"`);
  }
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (style.borders[side]) {
      cellProperties.push(`fo:border-${side}="0.75pt solid #111827"`);
    }
  }
  const textProperties: string[] = [];
  if (style.textColor !== undefined) {
    textProperties.push(`fo:color="${style.textColor}"`);
  }
  if (style.bold) {
    textProperties.push('fo:font-weight="bold"');
  }
  if (style.italic) {
    textProperties.push('fo:font-style="italic"');
  }
  const cellPropertyXml =
    cellProperties.length === 0
      ? ""
      : `\n      <style:table-cell-properties ${cellProperties.join(" ")}/>`;
  const textPropertyXml =
    textProperties.length === 0
      ? ""
      : `\n      <style:text-properties ${textProperties.join(" ")}/>`;
  const conditionalMapXml =
    style.conditional === undefined
      ? ""
      : `\n      <style:map style:condition="${xmlAttribute(
          style.conditional.condition,
        )}" style:apply-style-name="${xmlAttribute(style.conditional.applyStyleName)}"/>`;
  return `    <style:style style:name="${name}" style:family="table-cell">${cellPropertyXml}${textPropertyXml}${conditionalMapXml}\n    </style:style>`;
}

function odsConditionalCellStyleXml(name: string, style: OdsConditionalStyle): string {
  const cellProperties =
    style.fillColor === undefined ? "" : ` fo:background-color="${style.fillColor}"`;
  const textProperties = style.textColor === undefined ? "" : ` fo:color="${style.textColor}"`;
  const cellXml =
    cellProperties.length === 0 ? "" : `\n      <style:table-cell-properties${cellProperties}/>`;
  const textXml =
    textProperties.length === 0 ? "" : `\n      <style:text-properties${textProperties}/>`;
  return `    <style:style style:name="${name}" style:family="table-cell">${cellXml}${textXml}\n    </style:style>`;
}

function odsContentValidationXml(name: string, validation: ManualListValidation): string {
  const condition = `of:cell-content-is-in-list(${validation.choices
    .map((choice) => `"${choice.replace(/"/gu, '""')}"`)
    .join(",")})`;
  return `        <table:content-validation table:name="${name}" table:condition="${xmlAttribute(
    condition,
  )}" table:allow-empty-cell="true"/>`;
}

function odsAnnotationXml(note: string): string {
  return `<office:annotation>${note
    .split(/\r?\n/u)
    .map((line) => `<text:p>${xmlText(line)}</text:p>`)
    .join("")}</office:annotation>`;
}

function odsMetaXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta><dc:title>${xmlText(title)}</dc:title></office:meta>
</office:document-meta>`;
}

function odsStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>`;
}

function odsManifestXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;
}

function sheetCellBounds(cells: readonly SheetCellRecord[]): {
  readonly rowCount: number;
  readonly columnCount: number;
} {
  if (cells.length === 0) {
    return { rowCount: 0, columnCount: 0 };
  }
  return {
    rowCount: Math.max(...cells.map((cell) => cell.row)) + 1,
    columnCount: Math.max(...cells.map((cell) => cell.col)) + 1,
  };
}

function sheetCellBoundsWithComments(
  cells: readonly SheetCellRecord[],
  commentNotes: ReadonlyMap<string, string>,
): { readonly rowCount: number; readonly columnCount: number } {
  const bounds = sheetCellBounds(cells);
  let rowCount = bounds.rowCount;
  let columnCount = bounds.columnCount;
  for (const key of commentNotes.keys()) {
    const address = cellAddressFromCommentKey(key);
    if (address !== null) {
      rowCount = Math.max(rowCount, address.row + 1);
      columnCount = Math.max(columnCount, address.col + 1);
    }
  }
  return { rowCount, columnCount };
}

function cellA1(row: number, col: number): string {
  return `${columnLetter(col)}${String(row + 1)}`;
}

function columnLetter(index: number): string {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function xlsxWorksheetName(value: string): string {
  const normalized = value
    .replace(/[*?:/\\[\]]/gu, " ")
    .trim()
    .slice(0, 31);
  return normalized.length === 0 ? "Sheet" : normalized;
}

function exportFilenameBase(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "spreadsheet"
  );
}

function parseCsvForImport(csvText: string): {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly edits: readonly { readonly row: number; readonly col: number; readonly value: string }[];
} {
  const rows = parseDelimitedRows(csvText, ",", true);
  return parsedRowsForImport(rows, "CSV");
}

function parseTsvForImport(tsvText: string): {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly edits: readonly { readonly row: number; readonly col: number; readonly value: string }[];
} {
  const rows = parseDelimitedRows(tsvText, "\t", false);
  return parsedRowsForImport(rows, "TSV");
}

function parsedRowsForImport(
  rows: readonly string[][],
  formatLabel: "CSV" | "TSV",
): {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly edits: readonly { readonly row: number; readonly col: number; readonly value: string }[];
} {
  const edits: Array<{ readonly row: number; readonly col: number; readonly value: string }> = [];
  let columnCount = 0;
  rows.forEach((row, rowIndex) => {
    columnCount = Math.max(columnCount, row.length);
    row.forEach((value, colIndex) => {
      if (value.length === 0) {
        return;
      }
      edits.push({ row: rowIndex, col: colIndex, value });
    });
  });
  if (edits.length > 5_000) {
    throw new Error(
      `${formatLabel} import is limited to 5,000 populated cells for this first pass.`,
    );
  }
  return { rowCount: rows.length, columnCount, edits };
}

function parseDelimitedRows(
  text: string,
  delimiter: "," | "\t",
  allowQuotedFields: boolean,
): readonly string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (allowQuotedFields && char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.length > 1 || row[0]?.length !== 0 || text.endsWith(delimiter)) {
    rows.push(row);
  }
  return rows;
}

interface ImportedWorkbookTab {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly edits: readonly SheetCellEdit[];
}

async function parseXlsxForImport(contentBase64: string): Promise<{
  readonly tabs: readonly ImportedWorkbookTab[];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly populatedCellCount: number;
}> {
  const XLSX = await import("xlsx");
  const bytes = Buffer.from(contentBase64, "base64");
  const workbook = XLSX.read(bytes, {
    type: "buffer",
    cellDates: true,
    cellFormula: true,
    cellNF: true,
    sheetStubs: true,
  });

  const tabs: ImportedWorkbookTab[] = [];
  let rowCount = 0;
  let columnCount = 0;
  let populatedCellCount = 0;

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const edits: SheetCellEdit[] = [];
    let tabRowCount = 0;
    let tabColumnCount = 0;
    const range = typeof worksheet?.["!ref"] === "string" ? worksheet["!ref"] : undefined;
    if (worksheet !== undefined && range !== undefined) {
      const decoded = XLSX.utils.decode_range(range);
      for (let rowIndex = decoded.s.r; rowIndex <= decoded.e.r; rowIndex += 1) {
        tabRowCount = Math.max(tabRowCount, rowIndex + 1);
        for (let colIndex = decoded.s.c; colIndex <= decoded.e.c; colIndex += 1) {
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
          const cell = worksheet[address] as SheetJsCell | undefined;
          if (cell === undefined) {
            continue;
          }
          const value = sheetJsCellValueText(cell);
          if (value.length === 0) {
            continue;
          }
          tabColumnCount = Math.max(tabColumnCount, colIndex + 1);
          const format = xlsxCellFormat(cell);
          edits.push({
            row: rowIndex,
            col: colIndex,
            value,
            ...(format === undefined ? {} : { format }),
          });
        }
      }
    }
    rowCount = Math.max(rowCount, tabRowCount);
    columnCount = Math.max(columnCount, tabColumnCount);
    populatedCellCount += edits.length;
    if (populatedCellCount > 5_000) {
      throw new Error("XLSX import is limited to 5,000 populated cells for this first pass.");
    }
    tabs.push({
      name: importedWorkbookTabName(sheetName, tabs.length),
      rowCount: tabRowCount,
      columnCount: tabColumnCount,
      edits,
    });
  }

  if (tabs.length === 0) {
    throw new Error("XLSX workbook must contain at least one worksheet.");
  }
  return { tabs, rowCount, columnCount, populatedCellCount };
}

interface SheetJsCell {
  readonly t?: string;
  readonly v?: unknown;
  readonly f?: string;
  readonly z?: string;
  readonly w?: string;
  readonly numFmt?: string;
  readonly l?: { readonly Target?: unknown };
}

function sheetJsCellValueText(cell: SheetJsCell): string {
  if (typeof cell.f === "string" && cell.f.length > 0) {
    const formula = sanitizeImportedSpreadsheetText(cell.f);
    return formula.length > 0 ? `=${formula}` : "";
  }
  const value = sanitizeImportedSpreadsheetText(xlsxCellValueText(cell.v));
  if (value.length > 0) {
    return value;
  }
  if (cell.t === "e" && typeof cell.w === "string") {
    return sanitizeImportedSpreadsheetText(cell.w);
  }
  return "";
}

function importedWorkbookTabName(rawName: string, index: number): string {
  const fallback = `Sheet ${String(index + 1)}`;
  if (hasWorkbookTabControlCharacter(rawName)) {
    return fallback;
  }
  return sanitizeImportedSpreadsheetText(rawName).trim().slice(0, 120) || fallback;
}

function hasWorkbookTabControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function sanitizeImportedSpreadsheetText(value: string): string {
  return value.replaceAll("\u0000", "");
}

async function parseOdsForImport(contentBase64: string): Promise<{
  readonly tabs: readonly ImportedWorkbookTab[];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly populatedCellCount: number;
}> {
  const [{ XMLParser }, JSZip] = await Promise.all([
    import("fast-xml-parser"),
    import("jszip").then((module) => module.default),
  ]);
  const zip = await JSZip.loadAsync(Buffer.from(contentBase64, "base64"));
  const contentFile = zip.file("content.xml");
  if (contentFile === null) {
    throw new Error("ODS workbook is missing content.xml.");
  }
  const contentXml = await contentFile.async("string");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: false,
  });
  const parsed = asRecord(parser.parse(contentXml));
  const documentContent = asRecord(parsed["office:document-content"]);
  const body = asRecord(documentContent["office:body"]);
  const spreadsheet = asRecord(body["office:spreadsheet"]);
  const tables = toArray(spreadsheet["table:table"]).map(asRecord);
  if (tables.length === 0) {
    throw new Error("ODS workbook must contain at least one worksheet.");
  }

  const tabs: ImportedWorkbookTab[] = [];
  let rowCount = 0;
  let columnCount = 0;
  let populatedCellCount = 0;

  for (const table of tables) {
    const edits: SheetCellEdit[] = [];
    let tabRowCount = 0;
    let tabColumnCount = 0;
    let rowIndex = 0;
    for (const row of toArray(table["table:table-row"]).map(asRecord)) {
      const rowRepeat = limitedOdsRepeatCount(row["@_table:number-rows-repeated"]);
      for (let repeatedRow = 0; repeatedRow < rowRepeat; repeatedRow += 1) {
        let colIndex = 0;
        const cells = toArray(row["table:table-cell"]).map(asRecord);
        for (const cell of cells) {
          const colRepeat = limitedOdsRepeatCount(cell["@_table:number-columns-repeated"]);
          const value = odsCellValueText(cell);
          if (value.length > 0) {
            for (let repeatedCol = 0; repeatedCol < colRepeat; repeatedCol += 1) {
              edits.push({ row: rowIndex, col: colIndex + repeatedCol, value });
            }
            tabColumnCount = Math.max(tabColumnCount, colIndex + colRepeat);
          }
          colIndex += colRepeat;
        }
        tabRowCount = Math.max(tabRowCount, rowIndex + 1);
        rowIndex += 1;
      }
    }
    populatedCellCount += edits.length;
    if (populatedCellCount > 5_000) {
      throw new Error("ODS import is limited to 5,000 populated cells for this first pass.");
    }
    rowCount = Math.max(rowCount, tabRowCount);
    columnCount = Math.max(columnCount, tabColumnCount);
    const name = stringValue(table["@_table:name"]).trim();
    tabs.push({
      name: name.slice(0, 120) || `Sheet ${String(tabs.length + 1)}`,
      rowCount: tabRowCount,
      columnCount: tabColumnCount,
      edits,
    });
  }
  return { tabs, rowCount, columnCount, populatedCellCount };
}

function xlsxCellFormat(cell: {
  readonly numFmt?: string | undefined;
  readonly z?: string | undefined;
  readonly l?: { readonly Target?: unknown } | undefined;
}): JsonObject | undefined {
  const format: Record<string, string> = {};
  const linkUrl = normalizedSafeSheetLinkUrl(cell.l?.Target);
  if (linkUrl !== undefined) {
    format["linkUrl"] = linkUrl;
  }
  const numFmt = (cell.numFmt ?? cell.z)?.trim();
  if (numFmt !== undefined && SUPPORTED_CUSTOM_NUMBER_FORMAT_SET.has(numFmt)) {
    format["numberFormat"] = "custom";
    format["customNumberFormat"] = numFmt;
  }
  return Object.keys(format).length === 0 ? undefined : format;
}

function xlsxCellValueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["formula"] === "string") {
      return `=${record["formula"]}`;
    }
    if (typeof record["text"] === "string") {
      return record["text"];
    }
    if (Array.isArray(record["richText"])) {
      return record["richText"]
        .map((part) =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as Record<string, unknown>)["text"] === "string"
            ? String((part as Record<string, unknown>)["text"])
            : "",
        )
        .join("");
    }
    if (record["result"] !== undefined && record["result"] !== null) {
      return xlsxCellValueText(record["result"]);
    }
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "";
}

function odsCellValueText(cell: Record<string, unknown>): string {
  const formula = stringValue(cell["@_table:formula"]).trim();
  if (formula.length > 0) {
    return odsFormulaValueText(formula);
  }
  const valueType = stringValue(cell["@_office:value-type"]);
  if (valueType === "float" || valueType === "currency" || valueType === "percentage") {
    const value = stringValue(cell["@_office:value"]);
    return value.length > 0 ? value : odsParagraphText(cell["text:p"]);
  }
  if (valueType === "date") {
    const value = stringValue(cell["@_office:date-value"]);
    return value.length > 0 ? value : odsParagraphText(cell["text:p"]);
  }
  if (valueType === "boolean") {
    const value = stringValue(cell["@_office:boolean-value"]);
    return value.length > 0 ? value : odsParagraphText(cell["text:p"]);
  }
  const text = odsParagraphText(cell["text:p"]);
  if (text.length > 0) {
    return text;
  }
  return stringValue(cell["@_office:string-value"]);
}

function odsFormulaValueText(value: string): string {
  const trimmed = value.trim();
  const withoutNamespace = trimmed.startsWith("of:") ? trimmed.slice(3) : trimmed;
  const formula = withoutNamespace.startsWith("=") ? withoutNamespace : `=${withoutNamespace}`;
  return helixFormulaFromOdsFormula(formula);
}

function odsFormulaFromHelixFormula(value: string): string {
  const formula = value.trimStart().replace(/^=/u, "");
  const ranges: string[] = [];
  const withoutRanges = formula.replace(
    /\b([A-Z]+[1-9][0-9]*):([A-Z]+[1-9][0-9]*)\b/gu,
    (_match, start: string, end: string) => {
      const token = `__HELIX_ODS_RANGE_${String(ranges.length)}__`;
      ranges.push(`[.${start}:.${end}]`);
      return token;
    },
  );
  const withCells = withoutRanges.replace(/\b([A-Z]+[1-9][0-9]*)\b/gu, "[.$1]");
  return ranges.reduce(
    (current, range, index) => current.replace(`__HELIX_ODS_RANGE_${String(index)}__`, range),
    withCells,
  );
}

function helixFormulaFromOdsFormula(value: string): string {
  return value.replace(
    /\[\.([A-Z]+[1-9][0-9]*)(?::\.?([A-Z]+[1-9][0-9]*))?\]/gu,
    (_match, start: string, end: string | undefined) =>
      end === undefined ? start : `${start}:${end}`,
  );
}

function odsParagraphText(value: unknown): string {
  return toArray(value)
    .map((part) => {
      if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") {
        return String(part);
      }
      const record = asRecord(part);
      return stringValue(record["#text"]);
    })
    .join("\n");
}

function limitedOdsRepeatCount(value: unknown): number {
  const numeric = Number(value ?? 1);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    return 1;
  }
  return Math.min(numeric, 5_000);
}

function toArray(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function xmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function xmlAttribute(value: string): string {
  return xmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function titleFromCsvFilename(filename: string): string {
  return filename.replace(/\.csv$/iu, "").trim() || "Imported CSV";
}

function titleFromTsvFilename(filename: string): string {
  return filename.replace(/\.tsv$/iu, "").trim() || "Imported TSV";
}

function titleFromWorkbookFilename(filename: string): string {
  return (
    filename.replace(/\.(xlsx|xlsm|xlsb|xltx|xltm|xls|ods)$/iu, "").trim() || "Imported workbook"
  );
}

function spreadsheetWorkbookSourceFormat(filename: string): string {
  const extension = /\.([^.]+)$/u.exec(filename.trim())?.[1]?.toLowerCase();
  switch (extension) {
    case "xls":
    case "xlsb":
    case "xlsm":
    case "xltx":
    case "xltm":
    case "xlsx":
      return extension;
    default:
      return "xlsx";
  }
}

function tabNameFromCsvFilename(filename: string): string {
  const base = titleFromCsvFilename(filename);
  return base.length > 120 ? base.slice(0, 120) : base;
}

function tabNameFromTsvFilename(filename: string): string {
  const base = titleFromTsvFilename(filename);
  return base.length > 120 ? base.slice(0, 120) : base;
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
