/* The contact list (all contacts or one label): a SelectableList table with
   A–Z sections, sort by first or last name, multi-select actions, hover
   actions, and loading, empty and error states. */
import type { Contact } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BookUser as ContactsIcon,
  SearchX as NoMatchIcon,
  Upload as ImportIcon,
  UserPlus as CreateIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SelectableList, SelectAllCheckbox } from "@/components/ui/selectable-list";
import { Skeleton } from "@/components/ui/skeleton";
import { contactLabelsQueryOptions, contactsListQueryOptions } from "./api";
import { ListActions, SelectionToolbar } from "./contact-list-toolbar";
import { ContactRow, type ContactRowHandlers } from "./contact-row";
import { useContactsFrameActions } from "./contacts-frame";
import {
  listName,
  matchesContactQuery,
  sectionLetter,
  sortContacts,
  type ContactSortOrder,
} from "./model";
import { useContactActions } from "./use-contact-actions";
import { useContactsShortcuts } from "./use-contacts-shortcuts";

const SORT_KEY = "helix.contacts.sort";

function readSort(): ContactSortOrder {
  try {
    return window.localStorage.getItem(SORT_KEY) === "last" ? "last" : "first";
  } catch {
    return "first";
  }
}

function useSortOrder(): [ContactSortOrder, (order: ContactSortOrder) => void] {
  const [sort, setSort] = useState<ContactSortOrder>(readSort);
  return [
    sort,
    (order) => {
      setSort(order);
      try {
        window.localStorage.setItem(SORT_KEY, order);
      } catch {
        // The order still applies for this visit.
      }
    },
  ];
}

export function ContactList({ label, query }: { readonly label?: string; readonly query: string }) {
  const navigate = useNavigate();
  const frame = useContactsFrameActions();
  const actions = useContactActions();
  const list = useQuery(contactsListQueryOptions("contacts"));
  const labels = useQuery(contactLabelsQueryOptions());
  const [sort, setSort] = useSortOrder();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const contacts = useMemo(() => {
    const all = list.data?.contacts ?? [];
    const wanted = label?.toLocaleLowerCase();
    return sortContacts(
      all.filter(
        (contact) =>
          (wanted === undefined ||
            contact.labels.some((name) => name.toLocaleLowerCase() === wanted)) &&
          matchesContactQuery(contact, query),
      ),
      sort,
    );
  }, [list.data, label, query, sort]);
  const keys = contacts.map((contact) => contact.id);
  const selected = contacts.filter((contact) => selectedKeys.has(contact.id));
  const letters = useMemo(() => {
    const firstOfSection = new Map<string, string>();
    let previous: string | null = null;
    for (const contact of contacts) {
      const letter = sectionLetter(contact, sort);
      if (letter !== previous) firstOfSection.set(contact.id, letter);
      previous = letter;
    }
    return firstOfSection;
  }, [contacts, sort]);

  const open = (contact: Contact) =>
    void navigate({ to: "/contacts/$contactId", params: { contactId: contact.id } });
  const edit = (id: string) =>
    void navigate({
      to: "/contacts/$contactId",
      params: { contactId: id },
      search: { edit: true },
    });
  const create = () =>
    void navigate({ to: "/contacts/new", search: label === undefined ? {} : { label } });
  const remove = (ids: readonly string[]) => {
    setSelectedKeys(new Set());
    void actions.trash(ids);
  };

  useContactsShortcuts({
    onCreate: create,
    listKeys: keys,
    selectedKeys,
    onSelectedKeysChange: setSelectedKeys,
    onEdit: edit,
    onDelete: remove,
  });

  const handlers: ContactRowHandlers = {
    onStar: (contact, starred) => void actions.setStarred(contact, starred),
    onEdit: (contact) => edit(contact.id),
    onExport: (contact) => void actions.exportVcard({ ids: [contact.id] }),
    onDelete: (contact) => remove([contact.id]),
  };

  const title = label ?? "Contacts";
  const body = (() => {
    if (list.error !== null) {
      return (
        <InlineError
          title="Couldn’t load your contacts"
          message={list.error.message}
          onRetry={() => void actions.refresh()}
          retrying={list.isFetching}
        />
      );
    }
    if (list.data === undefined)
      return <Skeleton variant="row" count={8} label="Loading contacts" />;
    if (contacts.length === 0) {
      if (query.trim().length > 0) {
        return (
          <EmptyState
            icon={<NoMatchIcon size={40} />}
            title={`No contacts match “${query.trim()}”`}
            body="Check the spelling, or search by email address or phone number."
          />
        );
      }
      if (label !== undefined) {
        return (
          <EmptyState
            icon={<ContactsIcon size={40} />}
            title="No contacts with this label"
            body="Select contacts in Contacts, then choose Manage labels to add them here."
          />
        );
      }
      return (
        <EmptyState
          icon={<ContactsIcon size={40} />}
          title="No contacts yet"
          body="Add the people you email, chat and meet with, or bring them in from a file."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className="btn primary" onClick={create}>
                <CreateIcon size={16} aria-hidden="true" />
                Create contact
              </button>
              <button type="button" className="btn" onClick={frame.openImport}>
                <ImportIcon size={16} aria-hidden="true" />
                Import
              </button>
            </div>
          }
        />
      );
    }
    return (
      <div className="contacts-table">
        <div className="contacts-table-head" aria-hidden="true">
          <span className="contacts-head-check" />
          <span className="contacts-row">
            <span className="contacts-letter" />
            <span className="contacts-col-name">Name</span>
            <span className="contacts-col-email">Email</span>
            <span className="contacts-col-phone">Phone number</span>
            <span className="contacts-col-job">Job title &amp; company</span>
            <span className="contacts-col-labels">Labels</span>
            <span className="contacts-row-actions" />
          </span>
        </div>
        <SelectableList
          items={contacts}
          getKey={(contact) => contact.id}
          getItemLabel={(contact) => contact.displayName}
          label={title}
          selectedKeys={selectedKeys}
          onSelectedKeysChange={setSelectedKeys}
          activeKey={activeKey}
          onActiveKeyChange={setActiveKey}
          onOpen={open}
          rowClassName={() => "contacts-list-row"}
          renderItem={(contact, state) => (
            <ContactRow
              contact={contact}
              name={listName(contact, sort)}
              letter={letters.get(contact.id) ?? null}
              state={state}
              handlers={handlers}
            />
          )}
        />
      </div>
    );
  })();

  return (
    <section className="contacts-main" aria-labelledby="contacts-list-title">
      <header className="contacts-list-header">
        {selected.length > 0 ? (
          <SelectionToolbar
            leading={
              <>
                <h1 id="contacts-list-title" className="sr-only">
                  {title}
                </h1>
                <SelectAllCheckbox
                  total={contacts.length}
                  selectedCount={selected.length}
                  onToggle={(all) => setSelectedKeys(all ? new Set(keys) : new Set())}
                  label="Select all contacts"
                />
              </>
            }
            selected={selected}
            labels={labels.data?.labels ?? []}
            onClear={() => setSelectedKeys(new Set())}
            onLabel={(name, add) =>
              void actions.applyLabels(
                selected.map((contact) => contact.id),
                add ? { add: [name] } : { remove: [name] },
              )
            }
            onCreateLabel={frame.openCreateLabel}
            onExport={() =>
              void actions.exportVcard({ ids: selected.map((contact) => contact.id) })
            }
            onDelete={() => remove(selected.map((contact) => contact.id))}
          />
        ) : (
          <div className="contacts-title-row">
            {contacts.length > 0 ? (
              <SelectAllCheckbox
                total={contacts.length}
                selectedCount={selected.length}
                onToggle={(all) => setSelectedKeys(all ? new Set(keys) : new Set())}
                label="Select all contacts"
              />
            ) : null}
            <h1 id="contacts-list-title" className="type-h2 m-0">
              {title}
              {list.data === undefined ? null : (
                <span className="contacts-count"> ({contacts.length.toLocaleString()})</span>
              )}
            </h1>
            <span className="flex-1" />
            <ListActions
              sort={sort}
              onSortChange={setSort}
              canExport={contacts.length > 0}
              onExport={() => void actions.exportVcard(label === undefined ? {} : { label })}
            />
          </div>
        )}
      </header>
      {list.data !== undefined && list.data.total > list.data.contacts.length ? (
        <p className="contacts-note type-body-sm" role="note">
          Showing the first {list.data.contacts.length.toLocaleString()} of{" "}
          {list.data.total.toLocaleString()} contacts.
        </p>
      ) : null}
      <div className="contacts-scroll">{body}</div>
      <button type="button" className="contacts-fab focus-ring" onClick={create}>
        <CreateIcon aria-hidden="true" />
        Create contact
      </button>
    </section>
  );
}
