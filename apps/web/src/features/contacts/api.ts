/* Contacts tool client. Every call goes through `callTool`, so the server's
   validation and authorization messages reach the UI unchanged. */
import type {
  Contact,
  ContactDuplicateGroup,
  ContactExportResult,
  ContactFieldsInput,
  ContactImportResult,
  ContactLabel,
  ContactLabelListResult,
  ContactListResult,
  ContactPatch,
  DirectoryListResult,
} from "@helix/contracts";
import { callTool } from "@/lib/tool-call";

export type ContactsView = "contacts" | "trash";

const contactsKey = ["contacts"] as const;

export const contactsQueryKeys = {
  all: contactsKey,
  list: (view: ContactsView) => [...contactsKey, "list", view] as const,
  detail: (id: string) => [...contactsKey, "detail", id] as const,
  labels: () => [...contactsKey, "labels"] as const,
  duplicates: () => [...contactsKey, "duplicates"] as const,
  directory: () => [...contactsKey, "directory"] as const,
};

function call<Output>(toolId: string, input: unknown): Promise<Output> {
  return callTool<Output>(toolId, input);
}

/** Every contact in a view (one page of up to 1,000); search and sort happen on screen. */
export function contactsListQueryOptions(view: ContactsView) {
  return {
    queryKey: contactsQueryKeys.list(view),
    queryFn: () => call<ContactListResult>("contacts.list", { view }),
    staleTime: 30_000,
  };
}

export function contactQueryOptions(id: string) {
  return {
    queryKey: contactsQueryKeys.detail(id),
    queryFn: async () =>
      (await call<{ readonly contact: Contact }>("contacts.get", { id })).contact,
    staleTime: 30_000,
    /** A missing contact stays missing; other failures retry as usual. */
    retry: (failures: number, error: Error) =>
      (error as { readonly status?: number }).status !== 404 && failures < 2,
  };
}

export function contactLabelsQueryOptions() {
  return {
    queryKey: contactsQueryKeys.labels(),
    queryFn: () => call<ContactLabelListResult>("contacts.labels.list", {}),
    staleTime: 30_000,
  };
}

export function contactDuplicatesQueryOptions() {
  return {
    queryKey: contactsQueryKeys.duplicates(),
    queryFn: async () =>
      (
        await call<{ readonly groups: readonly ContactDuplicateGroup[] }>(
          "contacts.duplicates.list",
          {},
        )
      ).groups,
    staleTime: 60_000,
  };
}

export function directoryQueryOptions() {
  return {
    queryKey: contactsQueryKeys.directory(),
    queryFn: () => call<DirectoryListResult>("contacts.directory.list", {}),
    staleTime: 60_000,
  };
}

export async function createContact(fields: ContactFieldsInput): Promise<Contact> {
  return (await call<{ readonly contact: Contact }>("contacts.create", fields)).contact;
}

export async function updateContact(id: string, patch: ContactPatch): Promise<Contact> {
  return (await call<{ readonly contact: Contact }>("contacts.update", { id, ...patch })).contact;
}

export async function trashContacts(ids: readonly string[]): Promise<readonly string[]> {
  return (await call<{ readonly ids: readonly string[] }>("contacts.trash", { ids })).ids;
}

export async function restoreContacts(ids: readonly string[]): Promise<readonly string[]> {
  return (await call<{ readonly ids: readonly string[] }>("contacts.restore", { ids })).ids;
}

export async function purgeContacts(ids: readonly string[]): Promise<readonly string[]> {
  return (await call<{ readonly ids: readonly string[] }>("contacts.purge", { ids })).ids;
}

export async function mergeContacts(
  targetId: string,
  sourceIds: readonly string[],
): Promise<Contact> {
  return (await call<{ readonly contact: Contact }>("contacts.merge", { targetId, sourceIds }))
    .contact;
}

export function applyContactLabels(input: {
  readonly ids: readonly string[];
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}): Promise<ContactListResult> {
  return call<ContactListResult>("contacts.label.apply", {
    ids: input.ids,
    add: input.add ?? [],
    remove: input.remove ?? [],
  });
}

export async function createContactLabel(name: string): Promise<ContactLabel> {
  return (await call<{ readonly label: ContactLabel }>("contacts.label.create", { name })).label;
}

export async function renameContactLabel(name: string, newName: string): Promise<ContactLabel> {
  return (await call<{ readonly label: ContactLabel }>("contacts.label.rename", { name, newName }))
    .label;
}

export async function deleteContactLabel(name: string): Promise<void> {
  await call("contacts.label.delete", { name });
}

export function importContacts(input: {
  readonly format: "vcard" | "csv";
  readonly content: string;
  readonly dryRun: boolean;
  readonly label?: string;
}): Promise<ContactImportResult> {
  return call<ContactImportResult>("contacts.import", input);
}

export function exportContacts(input: {
  readonly ids?: readonly string[];
  readonly label?: string;
}): Promise<ContactExportResult> {
  return call<ContactExportResult>("contacts.export", input);
}
