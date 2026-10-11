/* One contact: photo, name, title and company, labels; Email, Chat,
   Schedule and Copy; then every email, phone, address, birthday and note. */
import type { Contact } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft as BackIcon,
  CalendarPlus as ScheduleIcon,
  Cake as BirthdayIcon,
  Copy as CopyIcon,
  Download as ExportIcon,
  Mail as MailIcon,
  MapPin as AddressIcon,
  MessageSquare as ChatIcon,
  MoreVertical as MoreIcon,
  Pencil as EditIcon,
  Phone as PhoneIcon,
  RotateCcw as RestoreIcon,
  Star as StarIcon,
  StickyNote as NotesIcon,
  Trash2 as TrashIcon,
  UserX as MissingIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/people/person-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import { contactQueryOptions } from "./api";
import {
  ADDRESS_TYPE_LABELS,
  EMAIL_TYPE_LABELS,
  PHONE_TYPE_LABELS,
  addressLines,
  contactSummary,
  formatBirthday,
  jobLine,
} from "./model";
import { useContactActions } from "./use-contact-actions";
import { useContactsShortcuts } from "./use-contacts-shortcuts";

function DetailRow({
  icon,
  label,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="contacts-detail-row">
      <span className="contacts-detail-icon" aria-hidden="true">
        {icon}
      </span>
      <dt className="sr-only">{label}</dt>
      <dd className="m-0 min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export function ContactDetail({ contactId }: { readonly contactId: string }) {
  const navigate = useNavigate();
  const actions = useContactActions();
  const query = useQuery(contactQueryOptions(contactId));
  const contact = query.data;
  const back = () => void navigate({ to: "/contacts" });
  const edit = () =>
    void navigate({ to: "/contacts/$contactId", params: { contactId }, search: { edit: true } });
  const remove = async () => {
    if (await actions.trash([contactId])) back();
  };

  useContactsShortcuts({
    onCreate: () => void navigate({ to: "/contacts/new" }),
    openContactId: contactId,
    ...(contact?.deletedAt === null ? { onEdit: edit, onDelete: () => void remove() } : {}),
  });

  const backButton = (
    <button
      type="button"
      className="contacts-icon-button focus-ring"
      aria-label="Back to contacts"
      title="Back"
      onClick={back}
    >
      <BackIcon aria-hidden="true" />
    </button>
  );

  if (contact === undefined) {
    return (
      <section className="contacts-main contacts-detail" aria-label="Contact">
        <div className="contacts-detail-bar">{backButton}</div>
        <div className="contacts-scroll">
          {query.error === null ? (
            <Skeleton variant="card" count={1} label="Loading contact" />
          ) : (query.error as { readonly status?: number }).status === 404 ? (
            <EmptyState
              icon={<MissingIcon size={40} />}
              title="Contact not found"
              body="It may have been deleted or merged into another contact."
              action={
                <button type="button" className="btn" onClick={back}>
                  Back to contacts
                </button>
              }
            />
          ) : (
            <InlineError
              title="Couldn’t load this contact"
              message={query.error.message}
              onRetry={() => void actions.refresh()}
              retrying={query.isFetching}
            />
          )}
        </div>
      </section>
    );
  }

  const email = contact.emails[0]?.value;
  const inTrash = contact.deletedAt !== null;
  return (
    <section className="contacts-main contacts-detail" aria-labelledby="contact-name">
      <div className="contacts-detail-bar">
        {backButton}
        <span className="flex-1" />
        {inTrash ? null : (
          <>
            <button
              type="button"
              className="contacts-icon-button contacts-star focus-ring"
              aria-pressed={contact.starred}
              aria-label={contact.starred ? "Unstar" : "Star"}
              title={contact.starred ? "Starred" : "Star"}
              data-starred={contact.starred || undefined}
              onClick={() => void actions.setStarred(contact, !contact.starred)}
            >
              <StarIcon aria-hidden="true" />
            </button>
            <button type="button" className="btn primary" onClick={edit}>
              <EditIcon size={16} aria-hidden="true" />
              Edit
            </button>
            <Menu>
              <MenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="contacts-icon-button text-muted-foreground focus-ring"
                  aria-label="More actions"
                  title="More actions"
                >
                  <MoreIcon aria-hidden="true" />
                </Button>
              </MenuTrigger>
              <MenuContent align="end" aria-label="Contact actions">
                <MenuItem
                  icon={<ExportIcon />}
                  onSelect={() => void actions.exportVcard({ ids: [contact.id] })}
                >
                  Export
                </MenuItem>
                <MenuItem
                  icon={<TrashIcon />}
                  shortcut="#"
                  destructive
                  onSelect={() => void remove()}
                >
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        )}
      </div>
      <div className="contacts-scroll">
        {inTrash ? (
          <div className="contacts-trash-banner" role="status">
            <span>This contact is in Trash.</span>
            <button
              type="button"
              className="btn"
              onClick={() => void actions.restore([contact.id])}
            >
              <RestoreIcon size={16} aria-hidden="true" />
              Recover
            </button>
          </div>
        ) : null}
        <header className="contacts-hero">
          <PersonAvatar
            person={{ displayName: contact.displayName, avatarDataUrl: contact.photoDataUrl }}
            size={112}
          />
          <div className="min-w-0">
            <h1 id="contact-name" className="type-h1 m-0">
              {contact.displayName}
            </h1>
            {jobLine(contact).length > 0 ? (
              <p className="m-0 type-body-lg text-muted-foreground">{jobLine(contact)}</p>
            ) : null}
            {contact.labels.length > 0 ? (
              <ul className="contacts-chip-list" aria-label="Labels">
                {contact.labels.map((label) => (
                  <li key={label}>
                    <button
                      type="button"
                      className="contacts-chip contacts-chip-link focus-ring"
                      onClick={() => void navigate({ to: "/contacts", search: { label } })}
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </header>
        <ContactActions contact={contact} />
        <section className="contacts-card" aria-labelledby="contact-details-title">
          <h2 id="contact-details-title" className="type-h3 m-0">
            Contact details
          </h2>
          <dl className="m-0">
            {contact.emails.map((entry) => (
              <DetailRow key={`email:${entry.value}`} icon={<MailIcon size={18} />} label="Email">
                <button
                  type="button"
                  className="contacts-link focus-ring"
                  onClick={() =>
                    void navigate({ to: "/mail", search: { compose: "new", to: entry.value } })
                  }
                >
                  {entry.value}
                </button>
                <span className="contacts-detail-type"> · {EMAIL_TYPE_LABELS[entry.type]}</span>
              </DetailRow>
            ))}
            {contact.phones.map((entry) => (
              <DetailRow key={`phone:${entry.value}`} icon={<PhoneIcon size={18} />} label="Phone">
                <a
                  className="contacts-link focus-ring"
                  href={`tel:${entry.value.replace(/[^0-9+#*]/gu, "")}`}
                >
                  {entry.value}
                </a>
                <span className="contacts-detail-type"> · {PHONE_TYPE_LABELS[entry.type]}</span>
              </DetailRow>
            ))}
            {contact.addresses.map((entry) => (
              <DetailRow
                key={`address:${addressLines(entry).join("|")}`}
                icon={<AddressIcon size={18} />}
                label="Address"
              >
                <address className="not-italic">
                  {addressLines(entry).map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </address>
                <span className="contacts-detail-type">{ADDRESS_TYPE_LABELS[entry.type]}</span>
              </DetailRow>
            ))}
            {contact.birthday === null ? null : (
              <DetailRow icon={<BirthdayIcon size={18} />} label="Birthday">
                {formatBirthday(contact.birthday)}
              </DetailRow>
            )}
            {contact.notes.length > 0 ? (
              <DetailRow icon={<NotesIcon size={18} />} label="Notes">
                <p className="m-0 whitespace-pre-wrap">{contact.notes}</p>
              </DetailRow>
            ) : null}
          </dl>
          {email === undefined && contact.phones.length === 0 && contact.addresses.length === 0 ? (
            <p className="m-0 type-body-sm text-muted-foreground">
              No details yet.{" "}
              {inTrash ? null : (
                <button type="button" className="contacts-link focus-ring" onClick={edit}>
                  Add an email or phone
                </button>
              )}
            </p>
          ) : null}
        </section>
      </div>
    </section>
  );
}

/** Email, Chat (org members only), Schedule and Copy. */
function ContactActions({ contact }: { readonly contact: Contact }) {
  const navigate = useNavigate();
  const email = contact.emails[0]?.value;
  const actions: {
    readonly label: string;
    readonly icon: ReactNode;
    readonly onClick: () => void;
  }[] = [];
  if (email !== undefined) {
    actions.push({
      label: "Email",
      icon: <MailIcon aria-hidden="true" />,
      onClick: () => void navigate({ to: "/mail", search: { compose: "new", to: email } }),
    });
  }
  if (contact.memberActorId !== null) {
    const actorId = contact.memberActorId;
    actions.push({
      label: "Chat",
      icon: <ChatIcon aria-hidden="true" />,
      onClick: () => void navigate({ to: "/chat", search: { dm: actorId } }),
    });
  }
  if (email !== undefined) {
    actions.push({
      label: "Schedule",
      icon: <ScheduleIcon aria-hidden="true" />,
      onClick: () =>
        void navigate({ to: "/calendar", search: { create: "event", attendees: email } }),
    });
  }
  actions.push({
    label: "Copy",
    icon: <CopyIcon aria-hidden="true" />,
    onClick: () => {
      void navigator.clipboard
        .writeText(contactSummary(contact))
        .then(() => notify({ message: "Contact details copied" }))
        .catch(() => notify({ message: "Couldn't copy to the clipboard", tone: "error" }));
    },
  });
  return (
    <ul className="contacts-actions" aria-label="Contact actions">
      {actions.map((action) => (
        <li key={action.label}>
          <button type="button" className="contacts-action focus-ring" onClick={action.onClick}>
            <span className="contacts-action-icon">{action.icon}</span>
            {action.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
