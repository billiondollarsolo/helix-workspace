/*
 * Contacts tools: the signed-in member's personal contacts (their default
 * CardDAV address book), contact labels, vCard/CSV import and vCard export,
 * duplicate merging, and the read-only organization directory. Web, CLI, MCP
 * and the assistant all call these.
 */
import {
  contactCreateInputSchema,
  contactDuplicateListInputSchema,
  contactDuplicateListResultSchema,
  contactExportInputSchema,
  contactExportResultSchema,
  contactGetInputSchema,
  contactIdsInputSchema,
  contactIdsResultSchema,
  contactImportInputSchema,
  contactImportResultSchema,
  contactLabelApplyInputSchema,
  contactLabelCreateInputSchema,
  contactLabelDeleteInputSchema,
  contactLabelListInputSchema,
  contactLabelListResultSchema,
  contactLabelRenameInputSchema,
  contactLabelResultSchema,
  contactListInputSchema,
  contactListResultSchema,
  contactMergeInputSchema,
  contactResultSchema,
  contactUpdateInputSchema,
  directoryListInputSchema,
  directoryListResultSchema,
} from "@helix/contracts";
import type { ToolContext, ToolDefinition } from "@helix/sdk-types";
import { z, type ZodTypeAny } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { parseContactImport } from "./contact-import.js";
import type { ContactsActor, PostgresContactsStore } from "./contacts-store.js";

export type ContactsStore = Pick<
  PostgresContactsStore,
  | "list"
  | "get"
  | "create"
  | "update"
  | "trash"
  | "restore"
  | "purge"
  | "labels"
  | "createLabel"
  | "renameLabel"
  | "deleteLabel"
  | "applyLabels"
  | "importCards"
  | "exportCards"
  | "duplicates"
  | "merge"
  | "directory"
>;

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;
const labelDeleteResultSchema = z.object({ name: z.string() });

function schema<T extends ZodTypeAny>(value: T) {
  return zodToolSchema(value, genericObjectJsonSchema);
}

function owner(ctx: ToolContext): ContactsActor {
  return { orgId: ctx.actor.orgId, actorId: ctx.actor.id };
}

function createContactsToolDefinitions(store: ContactsStore): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof contactListInputSchema>, unknown>({
      id: "contacts.list",
      description:
        "List your contacts, or (view=trash) those deleted in the last 30 days. Filter by label or a query over names, company, emails and phone numbers.",
      permission: "contacts.read",
      sideEffects: "read",
      inputSchema: schema(contactListInputSchema),
      outputSchema: schema(contactListResultSchema),
      handler: (input, ctx) => store.list(owner(ctx), input),
    }),
    defineTool<z.output<typeof contactGetInputSchema>, unknown>({
      id: "contacts.get",
      description: "Read one of your contacts with every email, phone, address and label.",
      permission: "contacts.read",
      sideEffects: "read",
      inputSchema: schema(contactGetInputSchema),
      outputSchema: schema(contactResultSchema),
      handler: async (input, ctx) => ({ contact: await store.get(owner(ctx), input.id) }),
    }),
    defineTool<z.output<typeof contactCreateInputSchema>, unknown>({
      id: "contacts.create",
      description:
        "Create a contact in your address book. It needs a name, company, email or phone. Labels that do not exist yet are created.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactCreateInputSchema),
      outputSchema: schema(contactResultSchema),
      handler: async (input, ctx) => {
        const contact = await store.create(owner(ctx), input);
        await ctx.audit("contacts.contact.created", { contactId: contact.id });
        return { contact };
      },
    }),
    defineTool<z.output<typeof contactUpdateInputSchema>, unknown>({
      id: "contacts.update",
      description:
        "Change one of your contacts. Fields you give replace the stored value (lists are replaced whole); omitted fields stay as they are.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactUpdateInputSchema),
      outputSchema: schema(contactResultSchema),
      handler: async ({ id, ...patch }, ctx) => {
        const contact = await store.update(owner(ctx), id, patch);
        await ctx.audit("contacts.contact.updated", {
          contactId: contact.id,
          fields: Object.keys(patch),
        });
        return { contact };
      },
    }),
    defineTool<z.output<typeof contactIdsInputSchema>, unknown>({
      id: "contacts.trash",
      description:
        "Move contacts to Trash. They can be restored for 30 days, then they are deleted for good.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactIdsInputSchema),
      outputSchema: schema(contactIdsResultSchema),
      handler: async (input, ctx) => {
        const ids = [...(await store.trash(owner(ctx), input.ids))];
        await ctx.audit("contacts.contact.trashed", { contactIds: ids });
        return { ids };
      },
    }),
    defineTool<z.output<typeof contactIdsInputSchema>, unknown>({
      id: "contacts.restore",
      description: "Restore contacts from Trash.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactIdsInputSchema),
      outputSchema: schema(contactIdsResultSchema),
      handler: async (input, ctx) => {
        const ids = [...(await store.restore(owner(ctx), input.ids))];
        await ctx.audit("contacts.contact.restored", { contactIds: ids });
        return { ids };
      },
    }),
    defineTool<z.output<typeof contactIdsInputSchema>, unknown>({
      id: "contacts.purge",
      description:
        "Delete contacts in Trash forever. Contacts under a legal hold or retention period are kept.",
      permission: "contacts.write",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: schema(contactIdsInputSchema),
      outputSchema: schema(contactIdsResultSchema),
      handler: async (input, ctx) => {
        const ids = [...(await store.purge(owner(ctx), input.ids))];
        await ctx.audit("contacts.contact.purged", { contactIds: ids });
        return { ids };
      },
    }),
    defineTool<z.output<typeof contactDuplicateListInputSchema>, unknown>({
      id: "contacts.duplicates.list",
      description: "Find your contacts that share an email address or phone number.",
      permission: "contacts.read",
      sideEffects: "read",
      inputSchema: schema(contactDuplicateListInputSchema),
      outputSchema: schema(contactDuplicateListResultSchema),
      handler: async (_input, ctx) => ({ groups: await store.duplicates(owner(ctx)) }),
    }),
    defineTool<z.output<typeof contactMergeInputSchema>, unknown>({
      id: "contacts.merge",
      description:
        "Merge contacts into a target contact: the target keeps its values and gains the others' emails, phones, addresses and labels. The others move to Trash.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactMergeInputSchema),
      outputSchema: schema(contactResultSchema),
      handler: async (input, ctx) => {
        const contact = await store.merge(owner(ctx), input.targetId, input.sourceIds);
        await ctx.audit("contacts.contact.merged", {
          contactId: contact.id,
          mergedIds: input.sourceIds,
        });
        return { contact };
      },
    }),
    defineTool<z.output<typeof contactImportInputSchema>, unknown>({
      id: "contacts.import",
      description:
        "Import contacts from a vCard (.vcf) or CSV file's text. With dryRun, only validates and counts. Cards whose UID is already in your address book are updated.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactImportInputSchema),
      outputSchema: schema(contactImportResultSchema),
      handler: async (input, ctx) => {
        const parsed = parseContactImport(input);
        const result = {
          count: parsed.cards.length,
          skipped: parsed.skipped,
          problems: [...parsed.problems],
          sample: parsed.cards.slice(0, 5).map((card) => card.displayName),
          imported: false,
        };
        if (input.dryRun || parsed.cards.length === 0) return result;
        await store.importCards(owner(ctx), parsed.cards);
        await ctx.audit("contacts.contact.imported", {
          format: input.format,
          count: parsed.cards.length,
          skipped: parsed.skipped,
        });
        return { ...result, imported: true };
      },
    }),
    defineTool<z.output<typeof contactExportInputSchema>, unknown>({
      id: "contacts.export",
      description:
        "Export contacts as one vCard file: the given ids, a label, or every contact not in Trash.",
      permission: "contacts.read",
      sideEffects: "read",
      inputSchema: schema(contactExportInputSchema),
      outputSchema: schema(contactExportResultSchema),
      handler: async (input, ctx) => {
        const cards = await store.exportCards(owner(ctx), input);
        await ctx.audit("contacts.contact.exported", { count: cards.length });
        const stem = (input.label ?? "contacts").replace(/[^A-Za-z0-9._-]+/gu, "-") || "contacts";
        return { filename: `${stem}.vcf`, vcard: cards.join(""), count: cards.length };
      },
    }),
    defineTool<z.output<typeof contactLabelListInputSchema>, unknown>({
      id: "contacts.labels.list",
      description: "List your contact labels with how many contacts carry each.",
      permission: "contacts.read",
      sideEffects: "read",
      inputSchema: schema(contactLabelListInputSchema),
      outputSchema: schema(contactLabelListResultSchema),
      handler: (_input, ctx) => store.labels(owner(ctx)),
    }),
    defineTool<z.output<typeof contactLabelCreateInputSchema>, unknown>({
      id: "contacts.label.create",
      description: "Create a contact label.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactLabelCreateInputSchema),
      outputSchema: schema(contactLabelResultSchema),
      handler: async (input, ctx) => {
        const label = await store.createLabel(owner(ctx), input.name);
        await ctx.audit("contacts.label.created", { name: label.name });
        return { label };
      },
    }),
    defineTool<z.output<typeof contactLabelRenameInputSchema>, unknown>({
      id: "contacts.label.rename",
      description: "Rename a contact label on every contact that carries it.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactLabelRenameInputSchema),
      outputSchema: schema(contactLabelResultSchema),
      handler: async (input, ctx) => {
        const label = await store.renameLabel(owner(ctx), input.name, input.newName);
        await ctx.audit("contacts.label.renamed", { from: input.name, to: label.name });
        return { label };
      },
    }),
    defineTool<z.output<typeof contactLabelDeleteInputSchema>, unknown>({
      id: "contacts.label.delete",
      description:
        "Delete a contact label. Its contacts stay; only the label is removed from them.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactLabelDeleteInputSchema),
      outputSchema: schema(labelDeleteResultSchema),
      handler: async (input, ctx) => {
        await store.deleteLabel(owner(ctx), input.name);
        await ctx.audit("contacts.label.deleted", { name: input.name });
        return { name: input.name };
      },
    }),
    defineTool<z.output<typeof contactLabelApplyInputSchema>, unknown>({
      id: "contacts.label.apply",
      description: "Add labels to and remove labels from contacts.",
      permission: "contacts.write",
      sideEffects: "write",
      inputSchema: schema(contactLabelApplyInputSchema),
      outputSchema: schema(contactListResultSchema),
      handler: async (input, ctx) => {
        const contacts = [...(await store.applyLabels(owner(ctx), input))];
        await ctx.audit("contacts.label.applied", {
          contactIds: input.ids,
          added: input.add,
          removed: input.remove,
        });
        return { contacts, total: contacts.length };
      },
    }),
    defineTool<z.output<typeof directoryListInputSchema>, unknown>({
      id: "contacts.directory.list",
      description:
        "List people in your organization's directory (read-only), optionally matching a name or email.",
      permission: "contacts.read",
      sideEffects: "read",
      inputSchema: schema(directoryListInputSchema),
      outputSchema: schema(directoryListResultSchema),
      handler: (input, ctx) => store.directory(owner(ctx), input),
    }),
  ];
}

export function registerContactsTools(
  registry: RuntimeToolRegistry,
  options: { readonly store: ContactsStore },
): void {
  for (const tool of createContactsToolDefinitions(options.store)) registry.register(tool);
}
