/* Field groups for the contact form: repeatable email, phone and address
   rows with a type select, the birthday picker, and the label chooser. */
import {
  CONTACT_ADDRESS_TYPES,
  CONTACT_EMAIL_TYPES,
  CONTACT_LIMITS,
  CONTACT_PHONE_TYPES,
  type ContactLabel,
} from "@helix/contracts";
import {
  Cake as BirthdayIcon,
  Mail as MailIcon,
  MapPin as AddressIcon,
  Phone as PhoneIcon,
  Plus as PlusIcon,
  Tag as LabelIcon,
  X as RemoveIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useId, useState, type ReactNode } from "react";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ADDRESS_TYPE_LABELS,
  EMAIL_TYPE_LABELS,
  PHONE_TYPE_LABELS,
  birthdayToDate,
  dateToBirthday,
  emptyAddress,
  emptyEmail,
  emptyPhone,
  formatBirthday,
  type DraftAddress,
  type DraftEmail,
  type DraftPhone,
} from "./model";

interface GroupProps<T extends { readonly key: string }> {
  readonly entries: readonly T[];
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (entries: T[]) => void;
}

function FieldGroup({
  icon,
  legend,
  addLabel,
  canAdd,
  onAdd,
  children,
}: {
  readonly icon: ReactNode;
  readonly legend: string;
  readonly addLabel: string;
  readonly canAdd: boolean;
  readonly onAdd: () => void;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="contacts-field-group">
      <legend className="contacts-field-legend">
        <span aria-hidden="true">{icon}</span>
        {legend}
      </legend>
      <div className="grid gap-2">{children}</div>
      {canAdd ? (
        <button type="button" className="contacts-add-field focus-ring" onClick={onAdd}>
          <PlusIcon size={16} aria-hidden="true" />
          {addLabel}
        </button>
      ) : null}
    </fieldset>
  );
}

function RemoveButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="contacts-icon-button focus-ring"
      aria-label={label}
      title="Remove"
      onClick={onClick}
    >
      <RemoveIcon aria-hidden="true" />
    </button>
  );
}

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  return message === undefined ? null : (
    <p id={id} className="contacts-field-error m-0 type-caption text-destructive">
      {message}
    </p>
  );
}

function replace<T extends { readonly key: string }>(
  entries: readonly T[],
  key: string,
  patch: Partial<T>,
): T[] {
  return entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry));
}

export function EmailFields({ entries, errors, onChange }: GroupProps<DraftEmail>) {
  const id = useId();
  return (
    <FieldGroup
      icon={<MailIcon size={18} />}
      legend="Email"
      addLabel="Add email"
      canAdd={entries.length < CONTACT_LIMITS.entries}
      onAdd={() => onChange([...entries, emptyEmail()])}
    >
      {entries.map((entry, index) => {
        const errorId = `${id}-${entry.key}-error`;
        return (
          <div key={entry.key} className="contacts-entry">
            <input
              type="email"
              className="input"
              aria-label={`Email ${String(index + 1)}`}
              placeholder="Email"
              autoComplete="off"
              value={entry.value}
              aria-invalid={errors[entry.key] !== undefined || undefined}
              aria-describedby={errors[entry.key] === undefined ? undefined : errorId}
              onChange={(event) =>
                onChange(replace(entries, entry.key, { value: event.target.value }))
              }
            />
            <select
              className="select"
              aria-label={`Email ${String(index + 1)} type`}
              value={entry.type}
              onChange={(event) =>
                onChange(
                  replace(entries, entry.key, { type: event.target.value as DraftEmail["type"] }),
                )
              }
            >
              {CONTACT_EMAIL_TYPES.map((type) => (
                <option key={type} value={type}>
                  {EMAIL_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <RemoveButton
              label={`Remove email ${String(index + 1)}`}
              onClick={() => onChange(entries.filter((candidate) => candidate.key !== entry.key))}
            />
            <FieldError id={errorId} message={errors[entry.key]} />
          </div>
        );
      })}
    </FieldGroup>
  );
}

export function PhoneFields({ entries, errors, onChange }: GroupProps<DraftPhone>) {
  const id = useId();
  return (
    <FieldGroup
      icon={<PhoneIcon size={18} />}
      legend="Phone"
      addLabel="Add phone"
      canAdd={entries.length < CONTACT_LIMITS.entries}
      onAdd={() => onChange([...entries, emptyPhone()])}
    >
      {entries.map((entry, index) => {
        const errorId = `${id}-${entry.key}-error`;
        return (
          <div key={entry.key} className="contacts-entry">
            <input
              type="tel"
              className="input"
              aria-label={`Phone ${String(index + 1)}`}
              placeholder="Phone"
              autoComplete="off"
              value={entry.value}
              aria-invalid={errors[entry.key] !== undefined || undefined}
              aria-describedby={errors[entry.key] === undefined ? undefined : errorId}
              onChange={(event) =>
                onChange(replace(entries, entry.key, { value: event.target.value }))
              }
            />
            <select
              className="select"
              aria-label={`Phone ${String(index + 1)} type`}
              value={entry.type}
              onChange={(event) =>
                onChange(
                  replace(entries, entry.key, { type: event.target.value as DraftPhone["type"] }),
                )
              }
            >
              {CONTACT_PHONE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {PHONE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <RemoveButton
              label={`Remove phone ${String(index + 1)}`}
              onClick={() => onChange(entries.filter((candidate) => candidate.key !== entry.key))}
            />
            <FieldError id={errorId} message={errors[entry.key]} />
          </div>
        );
      })}
    </FieldGroup>
  );
}

const ADDRESS_PARTS = [
  ["street", "Street address"],
  ["city", "City"],
  ["region", "State or region"],
  ["postalCode", "Postal code"],
  ["country", "Country or region"],
] as const;

export function AddressFields({ entries, errors, onChange }: GroupProps<DraftAddress>) {
  const id = useId();
  return (
    <FieldGroup
      icon={<AddressIcon size={18} />}
      legend="Address"
      addLabel="Add address"
      canAdd={entries.length < CONTACT_LIMITS.entries}
      onAdd={() => onChange([...entries, emptyAddress()])}
    >
      {entries.map((entry, index) => {
        const errorId = `${id}-${entry.key}-error`;
        return (
          <div key={entry.key} className="contacts-address">
            <div className="contacts-address-parts">
              {ADDRESS_PARTS.map(([part, label]) => (
                <input
                  key={part}
                  className="input"
                  data-part={part}
                  aria-label={`Address ${String(index + 1)} ${label.toLowerCase()}`}
                  placeholder={label}
                  value={entry[part]}
                  aria-invalid={errors[entry.key] !== undefined || undefined}
                  aria-describedby={errors[entry.key] === undefined ? undefined : errorId}
                  onChange={(event) =>
                    onChange(replace(entries, entry.key, { [part]: event.target.value }))
                  }
                />
              ))}
            </div>
            <div className="contacts-entry">
              <select
                className="select"
                aria-label={`Address ${String(index + 1)} type`}
                value={entry.type}
                onChange={(event) =>
                  onChange(
                    replace(entries, entry.key, {
                      type: event.target.value as DraftAddress["type"],
                    }),
                  )
                }
              >
                {CONTACT_ADDRESS_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ADDRESS_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <RemoveButton
                label={`Remove address ${String(index + 1)}`}
                onClick={() => onChange(entries.filter((candidate) => candidate.key !== entry.key))}
              />
            </div>
            <FieldError id={errorId} message={errors[entry.key]} />
          </div>
        );
      })}
    </FieldGroup>
  );
}

export function BirthdayField({
  value,
  onChange,
}: {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <fieldset className="contacts-field-group">
      <legend className="contacts-field-legend">
        <span aria-hidden="true">
          <BirthdayIcon size={18} />
        </span>
        Birthday
      </legend>
      <div className="contacts-entry">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="contacts-birthday"
              aria-haspopup="dialog"
            >
              {value === null ? "Add birthday" : formatBirthday(value)}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" aria-label="Choose a birthday">
            <DateTimePicker
              mode="date"
              label="Birthday"
              value={birthdayToDate(value)}
              onChange={(date) => {
                onChange(dateToBirthday(date));
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {value === null ? null : (
          <RemoveButton label="Remove birthday" onClick={() => onChange(null)} />
        )}
      </div>
    </fieldset>
  );
}

export function LabelsField({
  value,
  labels,
  onChange,
}: {
  readonly value: readonly string[];
  readonly labels: readonly ContactLabel[];
  readonly onChange: (value: string[]) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const has = (name: string) =>
    value.some((label) => label.toLocaleLowerCase() === name.toLocaleLowerCase());
  const add = () => {
    const name = draft
      .trim()
      .replace(/[,;\\\r\n]/gu, " ")
      .slice(0, CONTACT_LIMITS.labelName);
    if (name.length > 0 && !has(name)) onChange([...value, name]);
    setDraft("");
  };
  return (
    <fieldset className="contacts-field-group">
      <legend className="contacts-field-legend">
        <span aria-hidden="true">
          <LabelIcon size={18} />
        </span>
        Labels
      </legend>
      {value.length > 0 ? (
        <ul className="contacts-chip-list" aria-label="Labels on this contact">
          {value.map((label) => (
            <li key={label} className="contacts-chip">
              {label}
              <button
                type="button"
                className="contacts-chip-remove focus-ring"
                aria-label={`Remove label ${label}`}
                onClick={() => onChange(value.filter((candidate) => candidate !== label))}
              >
                <RemoveIcon aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="contacts-entry">
        <input
          className="input"
          aria-label="New label"
          placeholder="Add a label"
          value={draft}
          maxLength={CONTACT_LIMITS.labelName}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
          aria-describedby={`${id}-hint`}
        />
        <button type="button" className="btn" disabled={draft.trim().length === 0} onClick={add}>
          Add
        </button>
        {labels.length > 0 ? (
          <Menu>
            <MenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                Choose
              </Button>
            </MenuTrigger>
            <MenuContent align="end" aria-label="Your labels">
              <MenuLabel>Your labels</MenuLabel>
              <MenuSeparator />
              {labels.map((label) => (
                <MenuCheckboxItem
                  key={label.name}
                  checked={has(label.name)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? [...value, label.name]
                        : value.filter(
                            (candidate) =>
                              candidate.toLocaleLowerCase() !== label.name.toLocaleLowerCase(),
                          ),
                    )
                  }
                >
                  {label.name}
                </MenuCheckboxItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="sr-only">
        Type a label and press Enter to add it.
      </p>
    </fieldset>
  );
}
