/* The Contacts surface chrome shared by every /contacts route: the top bar
   (its search filters the contact list), the left navigation, and the label
   and import dialogs the navigation opens. */
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BookUser as ContactsIcon } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { SurfaceFrame } from "@/components/shell";
import { notify } from "@/components/ui/toast";
import {
  contactDuplicatesQueryOptions,
  contactLabelsQueryOptions,
  createContactLabel,
  deleteContactLabel,
  renameContactLabel,
} from "./api";
import { ConfirmDialog, LabelNameDialog } from "./contacts-dialogs";
import { ContactsSidebar } from "./contacts-sidebar";
import { ImportContactsDialog } from "./import-dialog";
import type { ContactsLocation } from "./route-location";
import type { ContactsRouteSearch } from "./route-search";
import { useContactActions } from "./use-contact-actions";
import "./contacts.css";

interface ContactsFrameActions {
  readonly openImport: () => void;
  readonly openCreateLabel: () => void;
}

const FrameActions = createContext<ContactsFrameActions>({
  openImport: () => undefined,
  openCreateLabel: () => undefined,
});

/** Dialogs owned by the frame, for empty states and toolbars inside it. */
export function useContactsFrameActions(): ContactsFrameActions {
  return useContext(FrameActions);
}

type LabelDialog =
  | { readonly kind: "create" }
  | { readonly kind: "rename"; readonly name: string }
  | { readonly kind: "delete"; readonly name: string };

interface ContactsFrameProps {
  /** The highlighted navigation entry. */
  readonly location: ContactsLocation;
  /** The list's search text (empty outside the list). */
  readonly query?: string;
  readonly children: ReactNode;
}

function searchFor(location: ContactsLocation, query?: string): ContactsRouteSearch {
  const q = query !== undefined && query.trim().length > 0 ? { q: query } : {};
  if (location.kind === "label") return { label: location.label, ...q };
  return location.view === "contacts" ? q : { view: location.view, ...q };
}

export function ContactsFrame({ location, query = "", children }: ContactsFrameProps) {
  const navigate = useNavigate();
  const href = useLocation({ select: (current) => current.href });
  const actions = useContactActions();
  const labels = useQuery(contactLabelsQueryOptions());
  const duplicates = useQuery(contactDuplicatesQueryOptions());
  const [labelDialog, setLabelDialog] = useState<LabelDialog | null>(null);
  const [importing, setImporting] = useState(false);
  const labelNames = labels.data?.labels.map((label) => label.name) ?? [];
  const frameActions = useMemo<ContactsFrameActions>(
    () => ({
      openImport: () => setImporting(true),
      openCreateLabel: () => setLabelDialog({ kind: "create" }),
    }),
    [],
  );

  const goTo = (next: ContactsLocation, nextQuery?: string) => {
    void navigate({ to: "/contacts", search: searchFor(next, nextQuery) });
  };

  const saveLabel = async (save: () => Promise<unknown>, message: string): Promise<boolean> => {
    try {
      await save();
      notify({ message });
      await actions.refresh();
      return true;
    } catch (error) {
      notify({
        message: "Couldn't save the label",
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
      return false;
    }
  };

  return (
    <SurfaceFrame
      title="Contacts"
      icon={<ContactsIcon size={16} />}
      searchPlaceholder="Search contacts"
      navigationKey={href}
      searchValue={query}
      onSearchChange={(value) => {
        const target: ContactsLocation =
          location.kind === "view" && location.view === "directory"
            ? location
            : { kind: "view", view: "contacts" };
        void navigate({ to: "/contacts", search: searchFor(target, value), replace: true });
      }}
    >
      <ContactsSidebar
        location={location}
        contactCount={labels.data?.total}
        duplicateCount={duplicates.data?.length}
        labels={labels.data?.labels ?? []}
        onNavigate={(next) => goTo(next)}
        onCreate={() =>
          void navigate({
            to: "/contacts/new",
            search: location.kind === "label" ? { label: location.label } : {},
          })
        }
        onImport={() => setImporting(true)}
        onCreateLabel={() => setLabelDialog({ kind: "create" })}
        onRenameLabel={(name) => setLabelDialog({ kind: "rename", name })}
        onDeleteLabel={(name) => setLabelDialog({ kind: "delete", name })}
      />
      <FrameActions.Provider value={frameActions}>{children}</FrameActions.Provider>
      {labelDialog?.kind === "create" ? (
        <LabelNameDialog
          title="Create label"
          submitLabel="Save"
          existing={labelNames}
          onClose={() => setLabelDialog(null)}
          onSubmit={(name) => saveLabel(() => createContactLabel(name), `Label “${name}” created`)}
        />
      ) : null}
      {labelDialog?.kind === "rename" ? (
        <LabelNameDialog
          title="Rename label"
          submitLabel="Save"
          initialName={labelDialog.name}
          existing={labelNames}
          onClose={() => setLabelDialog(null)}
          onSubmit={async (name) => {
            const saved = await saveLabel(
              () => renameContactLabel(labelDialog.name, name),
              `Label renamed to “${name}”`,
            );
            if (saved && location.kind === "label" && location.label === labelDialog.name) {
              goTo({ kind: "label", label: name });
            }
            return saved;
          }}
        />
      ) : null}
      <ConfirmDialog
        open={labelDialog?.kind === "delete"}
        title={labelDialog?.kind === "delete" ? `Delete “${labelDialog.name}”?` : "Delete label?"}
        description="The label is removed from its contacts. The contacts themselves stay in Contacts."
        confirmLabel="Delete label"
        onOpenChange={(open) => {
          if (!open) setLabelDialog(null);
        }}
        onConfirm={() => {
          if (labelDialog?.kind !== "delete") return;
          const { name } = labelDialog;
          setLabelDialog(null);
          void saveLabel(() => deleteContactLabel(name), `Label “${name}” deleted`).then(() => {
            if (location.kind === "label" && location.label === name) {
              goTo({ kind: "view", view: "contacts" });
            }
          });
        }}
      />
      {importing ? (
        <ImportContactsDialog
          onClose={() => setImporting(false)}
          onImported={(label) =>
            goTo(label === null ? { kind: "view", view: "contacts" } : { kind: "label", label })
          }
        />
      ) : null}
    </SurfaceFrame>
  );
}
