/* The other Contacts lists: the read-only organization Directory, Trash,
   and Merge and fix (contacts that share an email or phone number). */
import type { Contact, ContactDuplicateGroup, DirectoryMember } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Building2 as DirectoryIcon,
  Check as CheckIcon,
  GitMerge as MergeIcon,
  Mail as MailIcon,
  MessageSquare as ChatIcon,
  RotateCcw as RestoreIcon,
  SearchX as NoMatchIcon,
  Trash2 as TrashIcon,
  UserPlus as AddIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { PersonAvatar } from "@/components/people/person-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SelectableList, SelectAllCheckbox } from "@/components/ui/selectable-list";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import {
  contactDuplicatesQueryOptions,
  contactsListQueryOptions,
  createContact,
  directoryQueryOptions,
  mergeContacts,
} from "./api";
import { ConfirmDialog } from "./contacts-dialogs";
import { matchesContactQuery, sortContacts } from "./model";
import { useContactActions } from "./use-contact-actions";

function ListHeader({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <header className="contacts-list-header">
      <div className="contacts-title-row">
        <h1 id="contacts-list-title" className="type-h2 m-0">
          {title}
        </h1>
        <span className="flex-1" />
        {children}
      </div>
    </header>
  );
}

function LoadState({
  error,
  onRetry,
  retrying,
  what,
}: {
  readonly error: Error | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly what: string;
}) {
  return error === null ? (
    <Skeleton variant="row" count={6} label={`Loading ${what}`} />
  ) : (
    <InlineError
      title={`Couldn’t load ${what}`}
      message={error.message}
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}

/* ---- Directory ------------------------------------------------------ */

export function DirectoryView({ query }: { readonly query: string }) {
  const navigate = useNavigate();
  const actions = useContactActions();
  const directory = useQuery(directoryQueryOptions());
  const contacts = useQuery(contactsListQueryOptions("contacts"));
  const [adding, setAdding] = useState<string | null>(null);
  const saved = new Set(
    (contacts.data?.contacts ?? []).flatMap((contact) =>
      contact.emails.map((email) => email.value.toLocaleLowerCase()),
    ),
  );
  const needle = query.trim().toLocaleLowerCase();
  const members = (directory.data?.members ?? []).filter(
    (member) =>
      needle.length === 0 ||
      member.displayName.toLocaleLowerCase().includes(needle) ||
      (member.email ?? "").toLocaleLowerCase().includes(needle),
  );

  const add = async (member: DirectoryMember) => {
    setAdding(member.actorId);
    const [givenName = "", ...rest] = member.displayName.split(/\s+/u);
    try {
      const contact = await createContact({
        givenName,
        familyName: rest.join(" "),
        jobTitle: member.jobTitle ?? "",
        emails: member.email === null ? [] : [{ type: "work", value: member.email }],
      });
      await actions.refresh();
      notify({
        message: `${contact.displayName} added to your contacts`,
        action: {
          label: "View",
          onAction: () =>
            void navigate({ to: "/contacts/$contactId", params: { contactId: contact.id } }),
        },
      });
    } catch (error) {
      notify({
        message: "Couldn't add the contact",
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    } finally {
      setAdding(null);
    }
  };

  return (
    <section className="contacts-main" aria-labelledby="contacts-list-title">
      <ListHeader title="Directory">
        <span className="type-body-sm text-muted-foreground">People in your organization</span>
      </ListHeader>
      <div className="contacts-scroll">
        {directory.data === undefined ? (
          <LoadState
            error={directory.error}
            onRetry={() => void actions.refresh()}
            retrying={directory.isFetching}
            what="the directory"
          />
        ) : members.length === 0 ? (
          <EmptyState
            icon={needle.length > 0 ? <NoMatchIcon size={40} /> : <DirectoryIcon size={40} />}
            title={
              needle.length > 0 ? `No one matches “${query.trim()}”` : "No one in the directory yet"
            }
            body={
              needle.length > 0
                ? "Try a name or an email address."
                : "People your administrator adds appear here."
            }
          />
        ) : (
          <ul className="contacts-directory" aria-label="People in your organization">
            {members.map((member) => {
              const inContacts =
                member.email !== null && saved.has(member.email.toLocaleLowerCase());
              return (
                <li key={member.actorId} className="contacts-directory-row">
                  <PersonAvatar person={member} size={36} />
                  <span className="contacts-name-text">
                    <span className="contacts-name">{member.displayName}</span>
                    <span className="contacts-name-detail">
                      {[member.jobTitle, member.email].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="contacts-directory-actions">
                    {member.email === null ? null : (
                      <button
                        type="button"
                        className="contacts-icon-button focus-ring"
                        aria-label={`Email ${member.displayName}`}
                        title="Email"
                        onClick={() =>
                          void navigate({
                            to: "/mail",
                            search: { compose: "new", to: member.email ?? "" },
                          })
                        }
                      >
                        <MailIcon aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="contacts-icon-button focus-ring"
                      aria-label={`Chat with ${member.displayName}`}
                      title="Chat"
                      onClick={() => void navigate({ to: "/chat", search: { dm: member.actorId } })}
                    >
                      <ChatIcon aria-hidden="true" />
                    </button>
                    {inContacts ? (
                      <span className="contacts-saved">
                        <CheckIcon size={16} aria-hidden="true" />
                        In your contacts
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={adding === member.actorId}
                        aria-busy={adding === member.actorId || undefined}
                        aria-label={`Add ${member.displayName} to my contacts`}
                        onClick={() => void add(member)}
                      >
                        <AddIcon size={16} aria-hidden="true" />
                        Add to my contacts
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---- Trash ------------------------------------------------------------ */

const DELETED_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function TrashView({ query }: { readonly query: string }) {
  const actions = useContactActions();
  const trash = useQuery(contactsListQueryOptions("trash"));
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<readonly string[] | null>(null);
  const contacts = useMemo(
    () =>
      sortContacts(
        (trash.data?.contacts ?? []).filter((contact) => matchesContactQuery(contact, query)),
        "first",
      ),
    [trash.data, query],
  );
  const selected = contacts.filter((contact) => selectedKeys.has(contact.id));
  const ids = (list: readonly Contact[]) => list.map((contact) => contact.id);

  return (
    <section className="contacts-main" aria-labelledby="contacts-list-title">
      <ListHeader title="Trash">
        {selected.length > 0 ? (
          <div className="flex items-center gap-2" role="toolbar" aria-label="Selected contacts">
            <span className="type-body-sm">{selected.length.toLocaleString()} selected</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSelectedKeys(new Set());
                void actions.restore(ids(selected));
              }}
            >
              <RestoreIcon size={16} aria-hidden="true" />
              Recover
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(ids(selected))}>
              <TrashIcon size={16} aria-hidden="true" />
              Delete forever
            </button>
          </div>
        ) : contacts.length > 0 ? (
          <button type="button" className="btn" onClick={() => setConfirm(ids(contacts))}>
            Empty Trash
          </button>
        ) : null}
      </ListHeader>
      <p className="contacts-note type-body-sm">
        Contacts in Trash are deleted forever after 30 days.
      </p>
      <div className="contacts-scroll">
        {trash.data === undefined ? (
          <LoadState
            error={trash.error}
            onRetry={() => void actions.refresh()}
            retrying={trash.isFetching}
            what="Trash"
          />
        ) : contacts.length === 0 ? (
          <EmptyState
            icon={<TrashIcon size={40} />}
            title="Trash is empty"
            body="Contacts you delete stay here for 30 days."
          />
        ) : (
          <div className="contacts-table">
            <div className="contacts-table-head">
              <span className="contacts-head-check">
                <SelectAllCheckbox
                  total={contacts.length}
                  selectedCount={selected.length}
                  onToggle={(all) => setSelectedKeys(all ? new Set(ids(contacts)) : new Set())}
                  label="Select all contacts in Trash"
                />
              </span>
            </div>
            <SelectableList
              items={contacts}
              getKey={(contact) => contact.id}
              getItemLabel={(contact) => contact.displayName}
              label="Contacts in Trash"
              selectedKeys={selectedKeys}
              onSelectedKeysChange={setSelectedKeys}
              selectOnClick
              rowClassName={() => "contacts-list-row"}
              renderItem={(contact) => (
                <span className="contacts-row contacts-row-simple">
                  <span className="contacts-col-name">
                    <PersonAvatar
                      person={{
                        displayName: contact.displayName,
                        avatarDataUrl: contact.photoDataUrl,
                      }}
                      size={32}
                    />
                    <span className="contacts-name">{contact.displayName}</span>
                  </span>
                  <span className="contacts-col-email">{contact.emails[0]?.value ?? ""}</span>
                  <span className="contacts-col-phone">
                    {contact.deletedAt === null
                      ? ""
                      : `Deleted ${DELETED_DATE.format(new Date(contact.deletedAt))}`}
                  </span>
                </span>
              )}
            />
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.length === 1
            ? "Delete this contact forever?"
            : `Delete ${String(confirm?.length ?? 0)} contacts forever?`
        }
        description="You can’t undo this. Contacts deleted forever are removed from every device that syncs your contacts."
        confirmLabel="Delete forever"
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm === null) return;
          setSelectedKeys(new Set());
          void actions.purge(confirm);
          setConfirm(null);
        }}
      />
    </section>
  );
}

/* ---- Merge and fix ---------------------------------------------------- */

/** The contact with the most information keeps its values. */
function mergeTarget(group: ContactDuplicateGroup): Contact | undefined {
  const score = (contact: Contact) =>
    [
      contact.givenName,
      contact.familyName,
      contact.company,
      contact.jobTitle,
      contact.notes,
    ].filter(Boolean).length +
    contact.emails.length +
    contact.phones.length +
    contact.addresses.length +
    (contact.birthday === null ? 0 : 1);
  return [...group.contacts].sort((left, right) => score(right) - score(left))[0];
}

export function MergeView() {
  const actions = useContactActions();
  const duplicates = useQuery(contactDuplicatesQueryOptions());
  const [merging, setMerging] = useState<string | null>(null);
  const groups = duplicates.data ?? [];

  const merge = async (group: ContactDuplicateGroup) => {
    const target = mergeTarget(group);
    if (target === undefined) return;
    const key = `${group.reason}:${group.value}`;
    setMerging(key);
    try {
      const merged = await mergeContacts(
        target.id,
        group.contacts.filter((contact) => contact.id !== target.id).map((contact) => contact.id),
      );
      notify({ message: `Merged into ${merged.displayName}` });
    } catch (error) {
      notify({
        message: "Couldn't merge",
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    } finally {
      setMerging(null);
      await actions.refresh();
    }
  };

  return (
    <section className="contacts-main" aria-labelledby="contacts-list-title">
      <ListHeader title="Merge and fix" />
      <div className="contacts-scroll">
        {duplicates.data === undefined ? (
          <LoadState
            error={duplicates.error}
            onRetry={() => void actions.refresh()}
            retrying={duplicates.isFetching}
            what="suggestions"
          />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<MergeIcon size={40} />}
            title="No duplicates found"
            body="Contacts that share an email address or phone number show up here."
          />
        ) : (
          <ul className="contacts-merge-list" aria-label="Duplicate contacts">
            {groups.map((group) => {
              const key = `${group.reason}:${group.value}`;
              return (
                <li key={key} className="contacts-merge-card">
                  <p className="m-0 type-body-sm text-muted-foreground">
                    {group.contacts.length} contacts share the{" "}
                    {group.reason === "email" ? "email" : "phone number"}{" "}
                    <strong>{group.value}</strong>
                  </p>
                  <ul className="contacts-merge-people">
                    {group.contacts.map((contact) => (
                      <li key={contact.id}>
                        <PersonAvatar
                          person={{
                            displayName: contact.displayName,
                            avatarDataUrl: contact.photoDataUrl,
                          }}
                          size={28}
                        />
                        {contact.displayName}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={merging === key}
                    aria-busy={merging === key || undefined}
                    onClick={() => void merge(group)}
                  >
                    Merge
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
