/*
 * The Contacts app's view of a vCard. Reading maps the properties the app
 * edits (N, FN, ORG, TITLE, EMAIL, TEL, ADR, BDAY, NOTE, CATEGORIES, PHOTO and
 * the Helix star) to typed fields; writing replaces only those properties, so
 * everything a CardDAV client stored (URL, RELATED, IMPP, custom X- fields)
 * survives an edit made in Helix.
 */
import {
  CONTACT_LIMITS,
  contactBirthdaySchema,
  type ContactAddress,
  type ContactAddressType,
  type ContactEmailType,
  type ContactFields,
  type ContactPatch,
  type ContactPhoneType,
} from "@helix/contracts";
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import { parseVCard } from "../dav/standards.js";

type VCardComponent = InstanceType<typeof ICAL.Component>;
type VCardProperty = InstanceType<typeof ICAL.Property>;

export interface ContactCard extends ContactFields {
  readonly displayName: string;
}

/** Reads the app's fields from a stored or uploaded vCard. */
export function readContactCard(vcard: string): ContactCard {
  return readComponent(parseVCard(vcard));
}

type FieldWriter = (card: VCardComponent, fields: ContactFields) => void;

/** One writer per field: each replaces only the properties that hold it. */
const FIELD_WRITERS: { readonly [K in keyof ContactFields]: FieldWriter } = {
  givenName: writeName,
  familyName: writeName,
  company: (card, fields) => {
    card.removeAllProperties("org");
    if (fields.company.length === 0) return;
    // ORG is structured (company;unit;…): a one-part value escapes any ';'.
    const org = new ICAL.Property("org", card);
    org.setValue([fields.company] as never);
    card.addProperty(org);
  },
  jobTitle: (card, fields) => {
    replaceText(card, "title", fields.jobTitle);
  },
  emails: (card, fields) => {
    card.removeAllProperties("email");
    for (const email of fields.emails) {
      const property = card.addPropertyWithValue("email", email.value);
      if (email.type !== "other") property.setParameter("type", email.type);
    }
  },
  phones: (card, fields) => {
    card.removeAllProperties("tel");
    for (const phone of fields.phones) {
      const property = card.addPropertyWithValue("tel", phone.value);
      const type = PHONE_TYPE_TOKEN[phone.type];
      if (type !== null) property.setParameter("type", type);
    }
  },
  addresses: (card, fields) => {
    card.removeAllProperties("adr");
    for (const address of fields.addresses) {
      const property = new ICAL.Property("adr", card);
      property.setValue([
        "",
        "",
        address.street,
        address.city,
        address.region,
        address.postalCode,
        address.country,
      ] as never);
      if (address.type !== "other") property.setParameter("type", address.type);
      card.addProperty(property);
    }
  },
  birthday: (card, fields) => {
    replaceText(card, "bday", fields.birthday ?? "");
  },
  notes: (card, fields) => {
    replaceText(card, "note", fields.notes);
  },
  labels: (card, fields) => {
    card.removeAllProperties("categories");
    const labels = uniqueLabels(fields.labels);
    if (labels.length === 0) return;
    const categories = new ICAL.Property("categories", card);
    categories.setValues(labels);
    card.addProperty(categories);
  },
  photoDataUrl: (card, fields) => {
    replaceText(card, "photo", fields.photoDataUrl ?? "");
  },
  starred: (card, fields) => {
    replaceText(card, "x-helix-favorite", fields.starred ? "true" : "");
  },
};

/** Fields that decide the FN when the card has no better one. */
const NAME_SOURCES = ["givenName", "familyName", "company"] as const;

/**
 * Applies `patch` to a vCard. Only the properties behind the given fields
 * change, so data Helix does not model (or cannot read, such as a binary
 * PHOTO) survives. Without `existing` a new vCard 4.0 card is started.
 */
export function writeContactCard(existing: string | null, patch: ContactPatch): string {
  const card = existing === null ? newCard() : parseVCard(existing);
  const given = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<ContactFields>;
  const merged: ContactFields = { ...readComponent(card), ...given };
  for (const key of Object.keys(FIELD_WRITERS) as (keyof ContactFields)[]) {
    if (key in given) FIELD_WRITERS[key](card, merged);
  }
  const hasName = NAME_SOURCES.some((key) => merged[key].length > 0);
  const renamed =
    NAME_SOURCES.some((key) => key in given) ||
    (!hasName && ("emails" in given || "phones" in given));
  if (renamed || firstText(card.getFirstProperty("fn")).length === 0) {
    card.removeAllProperties("fn");
    card.addPropertyWithValue("fn", contactDisplayName(merged));
  }
  if (card.getFirstProperty("n") === null) writeName(card, merged);
  return `${card.toString().trimEnd()}\r\n`;
}

function writeName(card: VCardComponent, fields: ContactFields): void {
  const previous = card.getFirstProperty("n")?.getFirstValue();
  const kept = Array.isArray(previous) ? previous.map((part) => text(part)) : [];
  card.removeAllProperties("n");
  const name = new ICAL.Property("n", card);
  name.setValue([
    fields.familyName,
    fields.givenName,
    kept[2] ?? "",
    kept[3] ?? "",
    kept[4] ?? "",
  ] as never);
  card.addProperty(name);
}

function replaceText(card: VCardComponent, name: string, value: string): void {
  card.removeAllProperties(name);
  if (value.length > 0) card.addPropertyWithValue(name, value);
}

/** FN for a card: the person's name, else the company, else an address or number. */
export function contactDisplayName(
  fields: Pick<ContactFields, "givenName" | "familyName" | "company" | "emails" | "phones">,
): string {
  const person = [fields.givenName, fields.familyName].filter((part) => part.length > 0).join(" ");
  return (
    [person, fields.company, fields.emails[0]?.value, fields.phones[0]?.value].find(
      (candidate): candidate is string => candidate !== undefined && candidate.length > 0,
    ) ?? "Unnamed contact"
  );
}

/** Case-insensitive de-duplication that keeps the first spelling. */
export function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const label of labels.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(label);
  }
  return unique;
}

export function sameLabel(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function newCard(): VCardComponent {
  const card = new ICAL.Component("vcard");
  card.addPropertyWithValue("version", "4.0");
  card.addPropertyWithValue("uid", `urn:uuid:${randomUUID()}`);
  return card;
}

function readComponent(card: VCardComponent): ContactCard {
  const name = card.getFirstProperty("n")?.getFirstValue();
  const nameParts = Array.isArray(name) ? name.map((part) => text(part)) : [];
  const fields: ContactFields = {
    givenName: clip(nameParts[1] ?? "", CONTACT_LIMITS.name),
    familyName: clip(nameParts[0] ?? "", CONTACT_LIMITS.name),
    company: clip(firstText(card.getFirstProperty("org")), CONTACT_LIMITS.name),
    jobTitle: clip(firstText(card.getFirstProperty("title")), CONTACT_LIMITS.name),
    emails: card
      .getAllProperties("email")
      .map((property) => ({ type: emailType(typeTokens(property)), value: firstText(property) }))
      .filter((email) => email.value.length > 0)
      .slice(0, CONTACT_LIMITS.entries),
    phones: card
      .getAllProperties("tel")
      .map((property) => ({
        type: phoneType(typeTokens(property)),
        value: clip(firstText(property).replace(/^tel:/iu, ""), 64),
      }))
      .filter((phone) => phone.value.length > 0)
      .slice(0, CONTACT_LIMITS.entries),
    addresses: card
      .getAllProperties("adr")
      .map(readAddress)
      .filter((address): address is ContactAddress => address !== null)
      .slice(0, CONTACT_LIMITS.entries),
    birthday: readBirthday(card.getFirstProperty("bday")?.getFirstValue()),
    notes: clip(firstText(card.getFirstProperty("note")), CONTACT_LIMITS.notes),
    labels: uniqueLabels(
      card
        .getAllProperties("categories")
        .flatMap((property) => property.getValues().map((value) => text(value))),
    )
      .map((label) => label.replace(/[\r\n,;\\]/gu, " ").slice(0, CONTACT_LIMITS.labelName))
      .slice(0, CONTACT_LIMITS.labels),
    photoDataUrl: readPhoto(firstText(card.getFirstProperty("photo"))),
    starred: firstText(card.getFirstProperty("x-helix-favorite")) === "true",
  };
  const formatted = firstText(card.getFirstProperty("fn"));
  return {
    ...fields,
    displayName:
      formatted.length > 0 ? clip(formatted, CONTACT_LIMITS.name) : contactDisplayName(fields),
  };
}

const PHONE_TYPE_TOKEN: Readonly<Record<ContactPhoneType, string | null>> = {
  mobile: "cell",
  work: "work",
  home: "home",
  main: "voice",
  other: null,
};

function typeTokens(property: VCardProperty): readonly string[] {
  const raw: unknown = property.getParameter("type");
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values.flatMap((value) => String(value).toLowerCase().split(","));
}

function emailType(tokens: readonly string[]): ContactEmailType {
  if (tokens.includes("work")) return "work";
  if (tokens.includes("home")) return "home";
  return "other";
}

function phoneType(tokens: readonly string[]): ContactPhoneType {
  if (tokens.includes("cell") || tokens.includes("mobile") || tokens.includes("iphone"))
    return "mobile";
  if (tokens.includes("work")) return "work";
  if (tokens.includes("home")) return "home";
  if (tokens.includes("voice") || tokens.includes("main")) return "main";
  return "other";
}

function addressType(tokens: readonly string[]): ContactAddressType {
  if (tokens.includes("work")) return "work";
  if (tokens.includes("home")) return "home";
  return "other";
}

function readAddress(property: VCardProperty): ContactAddress | null {
  const value = property.getFirstValue();
  const parts = Array.isArray(value) ? value.map((part) => text(part)) : [text(value)];
  const address = {
    type: addressType(typeTokens(property)),
    street: singleLine([parts[0], parts[1], parts[2]], CONTACT_LIMITS.text),
    city: singleLine([parts[3]], CONTACT_LIMITS.name),
    region: singleLine([parts[4]], CONTACT_LIMITS.name),
    postalCode: singleLine([parts[5]], 40),
    country: singleLine([parts[6]], CONTACT_LIMITS.name),
  };
  return [address.street, address.city, address.region, address.postalCode, address.country].some(
    (part) => part.length > 0,
  )
    ? address
    : null;
}

function readBirthday(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "month" in value && "day" in value) {
    const { year, month, day } = value as {
      readonly year: number | null;
      readonly month: number | null;
      readonly day: number | null;
    };
    if (month === null || day === null) return null;
    const prefix = year === null ? "--" : `${String(year).padStart(4, "0")}-`;
    return validBirthday(`${prefix}${pad(month)}-${pad(day)}`);
  }
  const raw = text(value);
  const full = /^(\d{4})-?(\d{2})-?(\d{2})/u.exec(raw);
  if (full !== null) return validBirthday(`${full[1] ?? ""}-${full[2] ?? ""}-${full[3] ?? ""}`);
  const noYear = /^--(\d{2})-?(\d{2})$/u.exec(raw);
  return noYear === null ? null : validBirthday(`--${noYear[1] ?? ""}-${noYear[2] ?? ""}`);
}

function validBirthday(value: string): string | null {
  return contactBirthdaySchema.safeParse(value).success ? value : null;
}

function readPhoto(value: string): string | null {
  return value.length <= CONTACT_LIMITS.photoBytes &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value)
    ? value
    : null;
}

function firstText(property: VCardProperty | null): string {
  if (property === null) return "";
  const value = property.getFirstValue();
  return (Array.isArray(value) ? text(value[0]) : text(value)).trim();
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function singleLine(parts: readonly (string | undefined)[], max: number): string {
  return clip(
    parts
      .map((part) => (part ?? "").replace(/[\r\n]+/gu, ", ").trim())
      .filter((part) => part.length > 0)
      .join(", "),
    max,
  );
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
