/* One contact in the list: A–Z section letter, avatar and name, email,
   phone, job title and company, labels, and hover actions (star, edit, ⋮). */
import type { Contact } from "@helix/contracts";
import {
  Download as ExportIcon,
  MoreVertical as MoreIcon,
  Pencil as EditIcon,
  Star as StarIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/people/person-chip";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import type { SelectableRowState } from "@/components/ui/selectable-list";
import { jobLine } from "./model";

export interface ContactRowHandlers {
  readonly onStar: (contact: Contact, starred: boolean) => void;
  readonly onEdit: (contact: Contact) => void;
  readonly onExport: (contact: Contact) => void;
  readonly onDelete: (contact: Contact) => void;
}

export function ContactRow({
  contact,
  name,
  letter,
  state,
  handlers,
}: {
  readonly contact: Contact;
  /** The name as the current sort order shows it. */
  readonly name: string;
  /** The A–Z section letter on the section's first row. */
  readonly letter: string | null;
  readonly state: SelectableRowState;
  readonly handlers: ContactRowHandlers;
}) {
  const email = contact.emails[0]?.value ?? "";
  const phone = contact.phones[0]?.value ?? "";
  const job = jobLine(contact);
  return (
    <div className="contacts-row">
      <span className="contacts-letter" aria-hidden="true">
        {letter}
      </span>
      <span className="contacts-col-name">
        <PersonAvatar
          person={{ displayName: contact.displayName, avatarDataUrl: contact.photoDataUrl }}
          size={32}
        />
        <span className="contacts-name-text">
          <span className="contacts-name" title={name}>
            {name}
          </span>
          <span className="contacts-name-detail">{email || phone || job}</span>
        </span>
      </span>
      <span className="contacts-col-email" title={email}>
        {email}
      </span>
      <span className="contacts-col-phone">{phone}</span>
      <span className="contacts-col-job" title={job}>
        {job}
      </span>
      <span className="contacts-col-labels">
        {contact.labels.slice(0, 2).map((label) => (
          <span key={label} className="contacts-chip">
            {label}
          </span>
        ))}
        {contact.labels.length > 2 ? (
          <span className="contacts-chip" title={contact.labels.slice(2).join(", ")}>
            +{contact.labels.length - 2}
          </span>
        ) : null}
      </span>
      <span className="contacts-row-actions" data-starred={contact.starred || undefined}>
        <button
          type="button"
          className="contacts-icon-button contacts-star focus-ring"
          tabIndex={state.tabIndex}
          aria-pressed={contact.starred}
          aria-label={
            contact.starred ? `Unstar ${contact.displayName}` : `Star ${contact.displayName}`
          }
          title={contact.starred ? "Starred" : "Star"}
          onClick={() => handlers.onStar(contact, !contact.starred)}
        >
          <StarIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="contacts-icon-button contacts-hover-action focus-ring"
          tabIndex={state.tabIndex}
          aria-label={`Edit ${contact.displayName}`}
          title="Edit contact"
          onClick={() => handlers.onEdit(contact)}
        >
          <EditIcon aria-hidden="true" />
        </button>
        <Menu>
          <MenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="contacts-icon-button text-muted-foreground contacts-hover-action focus-ring"
              tabIndex={state.tabIndex}
              aria-label={`More actions for ${contact.displayName}`}
              title="More actions"
            >
              <MoreIcon aria-hidden="true" />
            </Button>
          </MenuTrigger>
          <MenuContent align="end" aria-label={`Actions for ${contact.displayName}`}>
            <MenuItem icon={<ExportIcon />} onSelect={() => handlers.onExport(contact)}>
              Export
            </MenuItem>
            <MenuItem
              icon={<TrashIcon />}
              shortcut="#"
              destructive
              onSelect={() => handlers.onDelete(contact)}
            >
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </span>
    </div>
  );
}
