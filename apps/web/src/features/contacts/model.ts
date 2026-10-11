/* Pure helpers for the Contacts surface: sorting and A–Z sections, search,
   display strings, and the edit-form draft. */
import {
  contactAddressSchema,
  contactEmailSchema,
  contactHasIdentity,
  contactPhoneSchema,
  type Contact,
  type ContactAddress,
  type ContactAddressType,
  type ContactEmailType,
  type ContactFields,
  type ContactPatch,
  type ContactPhoneType,
} from "@helix/contracts";

export type ContactSortOrder = "first" | "last";

export const EMAIL_TYPE_LABELS: Readonly<Record<ContactEmailType, string>> = {
  home: "Home",
  work: "Work",
  other: "Other",
};
export const PHONE_TYPE_LABELS: Readonly<Record<ContactPhoneType, string>> = {
  mobile: "Mobile",
  work: "Work",
  home: "Home",
  main: "Main",
  other: "Other",
};
export const ADDRESS_TYPE_LABELS: Readonly<Record<ContactAddressType, string>> = {
  home: "Home",
  work: "Work",
  other: "Other",
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** The name the list sorts by: first or last name, falling back to the display name. */
function sortName(contact: Contact, order: ContactSortOrder): string {
  const primary = order === "first" ? contact.givenName : contact.familyName;
  const secondary = order === "first" ? contact.familyName : contact.givenName;
  return [primary, secondary].filter((part) => part.length > 0).join(" ") || contact.displayName;
}

/** The list label: "Lovelace, Ada" when sorting by last name, the card name otherwise. */
export function listName(contact: Contact, order: ContactSortOrder): string {
  if (order === "last" && contact.familyName.length > 0 && contact.givenName.length > 0) {
    return `${contact.familyName}, ${contact.givenName}`;
  }
  return contact.displayName;
}

export function sortContacts(
  contacts: readonly Contact[],
  order: ContactSortOrder,
): readonly Contact[] {
  return [...contacts].sort(
    (left, right) =>
      collator.compare(sortName(left, order), sortName(right, order)) ||
      left.id.localeCompare(right.id),
  );
}

/** The A–Z section a contact files under; anything else goes under "#". */
export function sectionLetter(contact: Contact, order: ContactSortOrder): string {
  const first = sortName(contact, order)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .charAt(0)
    .toLocaleUpperCase();
  return /^[A-Z]$/u.test(first) ? first : "#";
}

/** Case-insensitive match on names, company, title, emails, phones and labels. */
export function matchesContactQuery(contact: Contact, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  const digits = needle.replace(/\D/gu, "");
  return (
    [
      contact.displayName,
      contact.givenName,
      contact.familyName,
      contact.company,
      contact.jobTitle,
      ...contact.emails.map((email) => email.value),
      ...contact.labels,
    ].some((value) => value.toLocaleLowerCase().includes(needle)) ||
    contact.phones.some(
      (phone) =>
        phone.value.toLocaleLowerCase().includes(needle) ||
        (digits.length >= 3 && phone.value.replace(/\D/gu, "").includes(digits)),
    )
  );
}

/** "Engineer, Acme", "Engineer" or "Acme". */
export function jobLine(contact: Pick<Contact, "jobTitle" | "company">): string {
  return [contact.jobTitle, contact.company].filter((part) => part.length > 0).join(", ");
}

const BIRTHDAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const BIRTHDAY_NO_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** "December 10, 1815", or "December 10" for a birthday stored without a year. */
export function formatBirthday(value: string): string {
  const match = /^(\d{4}|-)-?(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return value;
  const year = match[1] === "-" ? 2000 : Number(match[1]);
  const date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3])));
  return (match[1] === "-" ? BIRTHDAY_NO_YEAR : BIRTHDAY_WITH_YEAR).format(date);
}

/** The birthday as a local date for the picker; year-less birthdays use this year. */
export function birthdayToDate(value: string | null): Date | null {
  if (value === null) return null;
  const match = /^(\d{4}|-)-?(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const year = match[1] === "-" ? new Date().getFullYear() : Number(match[1]);
  return new Date(year, Number(match[2]) - 1, Number(match[3]));
}

export function dateToBirthday(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addressLines(address: ContactAddress): readonly string[] {
  const locality = [address.city, address.region, address.postalCode]
    .filter((part) => part.length > 0)
    .join(" ");
  return [address.street, locality, address.country].filter((line) => line.length > 0);
}

/** The text "Copy contact" puts on the clipboard. */
export function contactSummary(contact: Contact): string {
  return [
    contact.displayName,
    jobLine(contact),
    ...contact.emails.map((email) => email.value),
    ...contact.phones.map((phone) => phone.value),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/* ---- Edit form draft ------------------------------------------------- */

interface Keyed {
  readonly key: string;
}
export type DraftEmail = Keyed & { type: ContactEmailType; value: string };
export type DraftPhone = Keyed & { type: ContactPhoneType; value: string };
export type DraftAddress = Keyed & {
  type: ContactAddressType;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

export interface ContactDraft {
  givenName: string;
  familyName: string;
  company: string;
  jobTitle: string;
  emails: DraftEmail[];
  phones: DraftPhone[];
  addresses: DraftAddress[];
  birthday: string | null;
  notes: string;
  labels: string[];
  photoDataUrl: string | null;
  starred: boolean;
}

let nextKey = 0;
function draftKey(): string {
  nextKey += 1;
  return `entry-${String(nextKey)}`;
}

export function emptyEmail(): DraftEmail {
  return { key: draftKey(), type: "home", value: "" };
}
export function emptyPhone(): DraftPhone {
  return { key: draftKey(), type: "mobile", value: "" };
}
export function emptyAddress(): DraftAddress {
  return {
    key: draftKey(),
    type: "home",
    street: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
  };
}

/** A form draft; a new contact starts with one empty email and phone row. */
export function draftFromContact(
  contact: Contact | null,
  defaults: { readonly labels?: readonly string[] } = {},
): ContactDraft {
  if (contact === null) {
    return {
      givenName: "",
      familyName: "",
      company: "",
      jobTitle: "",
      emails: [emptyEmail()],
      phones: [emptyPhone()],
      addresses: [],
      birthday: null,
      notes: "",
      labels: [...(defaults.labels ?? [])],
      photoDataUrl: null,
      starred: false,
    };
  }
  return {
    givenName: contact.givenName,
    familyName: contact.familyName,
    company: contact.company,
    jobTitle: contact.jobTitle,
    emails: contact.emails.map((email) => ({ key: draftKey(), ...email })),
    phones: contact.phones.map((phone) => ({ key: draftKey(), ...phone })),
    addresses: contact.addresses.map((address) => ({ key: draftKey(), ...address })),
    birthday: contact.birthday,
    notes: contact.notes,
    labels: [...contact.labels],
    photoDataUrl: contact.photoDataUrl,
    starred: contact.starred,
  };
}

function unkeyed<T extends Keyed>(entry: T): Omit<T, "key"> {
  return Object.fromEntries(Object.entries(entry).filter(([name]) => name !== "key")) as Omit<
    T,
    "key"
  >;
}
const trimmedValues = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).map(([name, part]) => [
      name,
      typeof part === "string" ? part.trim() : part,
    ]),
  ) as T;

/** The fields to save: blank rows dropped, text trimmed. */
export function fieldsFromDraft(draft: ContactDraft): ContactFields {
  return {
    givenName: draft.givenName.trim(),
    familyName: draft.familyName.trim(),
    company: draft.company.trim(),
    jobTitle: draft.jobTitle.trim(),
    emails: draft.emails
      .map(unkeyed)
      .map(trimmedValues)
      .filter((email) => email.value.length > 0),
    phones: draft.phones
      .map(unkeyed)
      .map(trimmedValues)
      .filter((phone) => phone.value.length > 0),
    addresses: draft.addresses
      .map(unkeyed)
      .map(trimmedValues)
      .filter((address) =>
        [address.street, address.city, address.region, address.postalCode, address.country].some(
          (part) => part.length > 0,
        ),
      ),
    birthday: draft.birthday,
    notes: draft.notes.trim(),
    labels: draft.labels,
    photoDataUrl: draft.photoDataUrl,
    starred: draft.starred,
  };
}

/** Only what the form changed, so values Helix cannot show stay as stored. */
export function patchFromDraft(original: Contact, draft: ContactDraft): ContactPatch {
  const fields = fieldsFromDraft(draft);
  return Object.fromEntries(
    (Object.keys(fields) as (keyof ContactFields)[])
      .filter((key) => JSON.stringify(fields[key]) !== JSON.stringify(original[key]))
      .map((key) => [key, fields[key]]),
  );
}

/** The name the form's avatar shows while typing; null before anything is typed. */
export function contactDisplayNamePreview(draft: ContactDraft): string | null {
  const person = [draft.givenName.trim(), draft.familyName.trim()].filter(Boolean).join(" ");
  return (
    [
      person,
      draft.company.trim(),
      draft.emails[0]?.value.trim(),
      draft.phones[0]?.value.trim(),
    ].find((candidate): candidate is string => candidate !== undefined && candidate.length > 0) ??
    null
  );
}

interface DraftErrors {
  readonly form?: string;
  /** Keyed by the entry's `key`. */
  readonly entries: Readonly<Record<string, string>>;
}

/** Field messages for the form; empty when the draft can be saved. */
export function draftErrors(draft: ContactDraft): DraftErrors {
  const fields = fieldsFromDraft(draft);
  const entries: Record<string, string> = {};
  const check = (
    key: string,
    result: { success: boolean; error?: { issues: { message: string }[] } },
  ) => {
    if (!result.success) entries[key] = result.error?.issues[0]?.message ?? "Check this value.";
  };
  for (const email of draft.emails) {
    if (email.value.trim().length > 0)
      check(email.key, contactEmailSchema.safeParse(unkeyed(trimmedValues(email))));
  }
  for (const phone of draft.phones) {
    if (phone.value.trim().length > 0)
      check(phone.key, contactPhoneSchema.safeParse(unkeyed(trimmedValues(phone))));
  }
  for (const address of draft.addresses) {
    const value = unkeyed(trimmedValues(address));
    if (
      [value.street, value.city, value.region, value.postalCode, value.country].some(
        (part) => part.length > 0,
      )
    ) {
      check(address.key, contactAddressSchema.safeParse(value));
    }
  }
  return {
    ...(contactHasIdentity(fields) ? {} : { form: "Add a name, company, email or phone." }),
    entries,
  };
}

export function hasDraftErrors(errors: DraftErrors): boolean {
  return errors.form !== undefined || Object.keys(errors.entries).length > 0;
}
