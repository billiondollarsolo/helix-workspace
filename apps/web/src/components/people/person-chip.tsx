import { X as XIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { personRefAddress, type PersonRef } from "@/features/people/person-ref";
import "./people.css";

export interface PersonAvatarProps {
  readonly person: Pick<PersonRef, "displayName" | "avatarDataUrl">;
  readonly size?: number;
}

/** Decorative avatar for a person: photo when present, otherwise deterministic initials. */
export function PersonAvatar({ person, size = 24 }: PersonAvatarProps) {
  return (
    <span className="person-avatar" aria-hidden="true">
      <Avatar
        name={person.displayName}
        size={size}
        {...(person.avatarDataUrl === null ? {} : { src: person.avatarDataUrl })}
      />
    </span>
  );
}

export interface PersonChipProps {
  readonly person: PersonRef;
  /** Renders the chip in the error color with an "invalid address" announcement. */
  readonly invalid?: boolean;
  /** Clicking the chip label calls this, e.g. to turn the chip back into editable text. */
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
}

export function PersonChip({ person, invalid = false, onEdit, onRemove }: PersonChipProps) {
  const address = personRefAddress(person);
  const content = (
    <>
      <PersonAvatar person={person} size={20} />
      <span className="person-chip-name">{person.displayName}</span>
      {invalid ? <span className="sr-only">, invalid address</span> : null}
    </>
  );
  return (
    <span className="person-chip" data-invalid={invalid ? "" : undefined} title={address}>
      {onEdit === undefined ? (
        <span className="person-chip-label">{content}</span>
      ) : (
        <button
          type="button"
          className="person-chip-label"
          aria-label={`Edit ${address}${invalid ? ", invalid address" : ""}`}
          onClick={onEdit}
        >
          {content}
        </button>
      )}
      {onRemove === undefined ? null : (
        <button
          type="button"
          className="person-chip-remove"
          aria-label={`Remove ${person.displayName}`}
          onClick={onRemove}
        >
          <XIcon size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
