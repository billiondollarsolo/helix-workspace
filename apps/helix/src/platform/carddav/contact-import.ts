/*
 * Reads a .vcf or .csv upload into vCards ready to store. vCards keep every
 * property they carry; CSV rows (the column layouts that Google Contacts and
 * Outlook export) become new vCard 4.0 cards. Nothing here touches storage.
 */
import {
  CONTACT_LIMITS,
  contactAddressSchema,
  contactBirthdaySchema,
  contactEmailSchema,
  contactFieldsSchema,
  contactHasIdentity,
  contactPhoneSchema,
  type ContactAddress,
  type ContactEmail,
  type ContactFields,
  type ContactPhone,
} from "@helix/contracts";
import { DavStandardsParseError } from "../dav/standards.js";
import { readContactCard, uniqueLabels, writeContactCard } from "./contact-card.js";
import { parseVcard } from "./store.js";

export interface ImportedCard {
  readonly vcard: string;
  readonly uid: string;
  readonly displayName: string;
}

interface ContactImportParse {
  readonly cards: readonly ImportedCard[];
  readonly skipped: number;
  readonly problems: readonly string[];
}

const MAX_PROBLEMS = 10;

export function parseContactImport(input: {
  readonly format: "vcard" | "csv";
  readonly content: string;
  readonly label?: string | undefined;
}): ContactImportParse {
  const entries =
    input.format === "vcard" ? vcardEntries(input.content) : csvEntries(input.content);
  const cards: ImportedCard[] = [];
  const problems: string[] = [];
  let skipped = 0;
  const skip = (message: string) => {
    skipped += 1;
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };
  for (const entry of entries) {
    if (cards.length >= CONTACT_LIMITS.importContacts) {
      skip(
        `Only the first ${String(CONTACT_LIMITS.importContacts)} contacts can be imported at once.`,
      );
      continue;
    }
    const result = entry.read();
    if ("problem" in result) {
      skip(`${entry.position}: ${result.problem}`);
      continue;
    }
    const labelled =
      input.label === undefined
        ? result.vcard
        : writeContactCard(result.vcard, {
            labels: uniqueLabels([...readContactCard(result.vcard).labels, input.label]),
          });
    const parsed = parseVcard("import.vcf", labelled);
    cards.push({
      vcard: parsed.vcard,
      uid: parsed.uid,
      displayName: readContactCard(parsed.vcard).displayName,
    });
  }
  if (entries.length === 0)
    problems.push(
      `No contacts were found in this ${input.format === "vcard" ? "vCard" : "CSV"} file.`,
    );
  return { cards, skipped, problems };
}

type EntryResult = { readonly vcard: string } | { readonly problem: string };

interface ImportEntry {
  readonly position: string;
  /** A vCard to store, or why the entry was skipped. */
  readonly read: () => EntryResult;
}

const NO_IDENTITY = "it has no name, company, email or phone.";

function vcardEntries(content: string): readonly ImportEntry[] {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD\s*$/iu.test(line)) current = [];
    if (current !== null) current.push(line);
    if (/^END:VCARD\s*$/iu.test(line) && current !== null) {
      blocks.push(current);
      current = null;
    }
  }
  return blocks.map((block, index) => ({
    position: `Card ${String(index + 1)}`,
    read: () => {
      try {
        const vcard = parseVcard("import.vcf", `${block.join("\r\n")}\r\n`).vcard;
        return contactHasIdentity(readContactCard(vcard)) ? { vcard } : { problem: NO_IDENTITY };
      } catch (error) {
        if (error instanceof DavStandardsParseError)
          return { problem: "it is not a valid vCard 3.0 or 4.0 card." };
        throw error;
      }
    },
  }));
}

function csvEntries(content: string): readonly ImportEntry[] {
  const rows = parseCsv(content.replace(/^\uFEFF/u, ""));
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  return rows.slice(1).flatMap((row, index) => {
    if (row.every((cell) => cell.trim().length === 0)) return [];
    const cell = (...names: readonly string[]) => {
      for (const name of names) {
        const column = header.indexOf(name);
        const value = column === -1 ? undefined : row[column]?.trim();
        if (value !== undefined && value.length > 0) return value;
      }
      return "";
    };
    return [
      {
        position: `Row ${String(index + 2)}`,
        read: () => {
          const fields = csvFields(cell);
          return "problem" in fields ? fields : { vcard: writeContactCard(null, fields) };
        },
      },
    ];
  });
}

type CellReader = (...names: readonly string[]) => string;

function csvFields(cell: CellReader): ContactFields | { readonly problem: string } {
  const emails: ContactEmail[] = [];
  const phones: ContactPhone[] = [];
  const addresses: ContactAddress[] = [];
  for (let slot = 1; slot <= CONTACT_LIMITS.entries; slot += 1) {
    const email = contactEmailSchema.safeParse({
      type: entryType(cell(`e-mail ${String(slot)} - label`, `e-mail ${String(slot)} - type`), [
        "home",
        "work",
      ]),
      value: cell(`e-mail ${String(slot)} - value`),
    });
    if (email.success) emails.push(email.data);
    const phone = contactPhoneSchema.safeParse({
      type: phoneEntryType(cell(`phone ${String(slot)} - label`, `phone ${String(slot)} - type`)),
      value: cell(`phone ${String(slot)} - value`),
    });
    if (phone.success) phones.push(phone.data);
    const prefix = `address ${String(slot)} - `;
    const address = contactAddressSchema.safeParse({
      type: entryType(cell(`${prefix}label`, `${prefix}type`), ["home", "work"]),
      street: cell(`${prefix}street`) || cell(`${prefix}formatted`).replace(/\s*\n\s*/gu, ", "),
      city: cell(`${prefix}city`),
      region: cell(`${prefix}region`),
      postalCode: cell(`${prefix}postal code`),
      country: cell(`${prefix}country`),
    });
    if (address.success) addresses.push(address.data);
  }
  for (const [column, type] of [
    ["e-mail address", "other"],
    ["e-mail 2 address", "other"],
    ["e-mail 3 address", "other"],
  ] as const) {
    const email = contactEmailSchema.safeParse({ type, value: cell(column) });
    if (email.success && !emails.some((entry) => entry.value === email.data.value))
      emails.push(email.data);
  }
  for (const [column, type] of [
    ["mobile phone", "mobile"],
    ["business phone", "work"],
    ["home phone", "home"],
    ["primary phone", "main"],
    ["other phone", "other"],
  ] as const) {
    const phone = contactPhoneSchema.safeParse({ type, value: cell(column) });
    if (phone.success) phones.push(phone.data);
  }
  const birthday = contactBirthdaySchema.safeParse(normalizeBirthday(cell("birthday")));
  const parsed = contactFieldsSchema.safeParse({
    givenName: cell("first name", "given name"),
    familyName: cell("last name", "family name"),
    company: cell("organization name", "organization 1 - name", "company"),
    jobTitle: cell("organization title", "organization 1 - title", "job title"),
    emails,
    phones,
    addresses,
    birthday: birthday.success ? birthday.data : null,
    notes: cell("notes"),
    labels: csvLabels(cell("labels", "group membership", "categories")),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem:
        issue === undefined ? "it could not be read." : `${issue.path.join(".")}: ${issue.message}`,
    };
  }
  return contactHasIdentity(parsed.data) ? parsed.data : { problem: NO_IDENTITY };
}

/** Google exports `* myContacts ::: Family`; Outlook uses `Family;Work`. */
function csvLabels(value: string): string[] {
  return uniqueLabels(
    value
      .split(/:::|;/u)
      .map((label) =>
        label
          .replace(/^\*\s*/u, "")
          .replace(/[,\\]/gu, " ")
          .trim(),
      )
      .filter((label) => label.length > 0 && label.toLowerCase() !== "mycontacts")
      .map((label) => label.slice(0, CONTACT_LIMITS.labelName)),
  ).slice(0, CONTACT_LIMITS.labels);
}

function entryType<T extends string>(label: string, known: readonly T[]): T | "other" {
  const normalized = label
    .replace(/^\*\s*/u, "")
    .trim()
    .toLowerCase();
  return known.find((type) => normalized === type) ?? "other";
}

function phoneEntryType(label: string): ContactPhone["type"] {
  const normalized = label
    .replace(/^\*\s*/u, "")
    .trim()
    .toLowerCase();
  if (normalized === "mobile" || normalized === "cell") return "mobile";
  if (normalized === "work" || normalized === "home" || normalized === "main") return normalized;
  return "other";
}

/** Accepts YYYY-MM-DD, --MM-DD and the M/D/YYYY that Outlook writes. */
function normalizeBirthday(value: string): string {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (us !== null) {
    return `${us[3] ?? ""}-${(us[1] ?? "").padStart(2, "0")}-${(us[2] ?? "").padStart(2, "0")}`;
  }
  return value;
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === undefined) break;
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
