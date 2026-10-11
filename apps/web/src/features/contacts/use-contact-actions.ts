/* Contact actions shared by the list, the detail page and shortcuts:
   delete with Undo, star, labels, export, and Trash. Each refreshes the
   contacts queries and reports the outcome in a snackbar. */
import type { Contact, ContactListResult } from "@helix/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { notify } from "@/components/ui/toast";
import {
  applyContactLabels,
  contactsQueryKeys,
  exportContacts,
  purgeContacts,
  restoreContacts,
  trashContacts,
  updateContact,
} from "./api";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Check your connection and try again.";
}

function counted(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count.toLocaleString()} ${many}`;
}

/** Saves `text` as a download named `filename`. */
function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

interface ContactActions {
  readonly refresh: () => Promise<void>;
  readonly trash: (ids: readonly string[]) => Promise<boolean>;
  readonly restore: (ids: readonly string[]) => Promise<void>;
  readonly purge: (ids: readonly string[]) => Promise<void>;
  readonly setStarred: (contact: Contact, starred: boolean) => Promise<void>;
  readonly applyLabels: (
    ids: readonly string[],
    change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
  ) => Promise<void>;
  readonly exportVcard: (input: {
    readonly ids?: readonly string[];
    readonly label?: string;
  }) => Promise<void>;
}

export function useContactActions(): ContactActions {
  const queryClient = useQueryClient();

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: contactsQueryKeys.all }),
    [queryClient],
  );

  /** Drops contacts from the cached list at once, before the server answers. */
  const hideFromList = useCallback(
    (ids: readonly string[]) => {
      const hidden = new Set(ids);
      queryClient.setQueryData<ContactListResult>(contactsQueryKeys.list("contacts"), (current) =>
        current === undefined
          ? current
          : {
              contacts: current.contacts.filter((contact) => !hidden.has(contact.id)),
              total:
                current.total - current.contacts.filter((contact) => hidden.has(contact.id)).length,
            },
      );
    },
    [queryClient],
  );

  const restore = useCallback(
    async (ids: readonly string[]) => {
      try {
        const restored = await restoreContacts(ids);
        notify({ message: counted(restored.length, "Contact restored", "contacts restored") });
      } catch (error) {
        notify({ message: "Couldn't restore", description: errorMessage(error), tone: "error" });
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const trash = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return false;
      hideFromList(ids);
      try {
        const trashed = await trashContacts(ids);
        notify({
          message: counted(trashed.length, "Contact moved to Trash", "contacts moved to Trash"),
          action: { label: "Undo", onAction: () => void restore(trashed) },
        });
        return true;
      } catch (error) {
        notify({ message: "Couldn't delete", description: errorMessage(error), tone: "error" });
        return false;
      } finally {
        await refresh();
      }
    },
    [hideFromList, refresh, restore],
  );

  const purge = useCallback(
    async (ids: readonly string[]) => {
      try {
        const purged = await purgeContacts(ids);
        const kept = ids.length - purged.length;
        notify({
          message: counted(purged.length, "Contact deleted forever", "contacts deleted forever"),
          ...(kept > 0
            ? {
                description: `${kept.toLocaleString()} kept by your organization's retention policy.`,
              }
            : {}),
        });
      } catch (error) {
        notify({
          message: "Couldn't delete forever",
          description: errorMessage(error),
          tone: "error",
        });
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const setStarred = useCallback(
    async (contact: Contact, starred: boolean) => {
      try {
        await updateContact(contact.id, { starred });
      } catch (error) {
        notify({
          message: "Couldn't update the star",
          description: errorMessage(error),
          tone: "error",
        });
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const applyLabels = useCallback(
    async (
      ids: readonly string[],
      change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
    ) => {
      try {
        await applyContactLabels({ ids, ...change });
        const added = change.add?.[0];
        const removed = change.remove?.[0];
        notify({
          message:
            added !== undefined
              ? `Added to “${added}”`
              : removed !== undefined
                ? `Removed from “${removed}”`
                : "Labels updated",
        });
      } catch (error) {
        notify({
          message: "Couldn't change labels",
          description: errorMessage(error),
          tone: "error",
        });
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const exportVcard = useCallback(
    async (input: { readonly ids?: readonly string[]; readonly label?: string }) => {
      try {
        const result = await exportContacts(input);
        if (result.count === 0) {
          notify({ message: "No contacts to export" });
          return;
        }
        downloadText(result.filename, result.vcard, "text/vcard;charset=utf-8");
        notify({ message: counted(result.count, "1 contact exported", "contacts exported") });
      } catch (error) {
        notify({ message: "Couldn't export", description: errorMessage(error), tone: "error" });
      }
    },
    [],
  );

  return useMemo(
    () => ({ refresh, trash, restore, purge, setStarred, applyLabels, exportVcard }),
    [refresh, trash, restore, purge, setStarred, applyLabels, exportVcard],
  );
}
