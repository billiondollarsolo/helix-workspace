import { z } from "zod";

/*
 * Personal contacts. Each contact is a vCard in the member's default CardDAV
 * address book, so CardDAV clients and the Contacts app read and write the
 * same cards. Labels are vCard CATEGORIES; a label can also exist with no
 * contacts.
 */

export const CONTACT_EMAIL_TYPES = ["home", "work", "other"] as const;
export const CONTACT_PHONE_TYPES = ["mobile", "work", "home", "main", "other"] as const;
export const CONTACT_ADDRESS_TYPES = ["home", "work", "other"] as const;
export type ContactEmailType = (typeof CONTACT_EMAIL_TYPES)[number];
export type ContactPhoneType = (typeof CONTACT_PHONE_TYPES)[number];
export type ContactAddressType = (typeof CONTACT_ADDRESS_TYPES)[number];

/** Upper bounds shared by the server and the web form. */
export const CONTACT_LIMITS = {
  name: 200,
  text: 500,
  notes: 10_000,
  entries: 20,
  labels: 50,
  labelName: 80,
  /** Data-URL photo; the web form downsizes pictures well below this. */
  photoBytes: 350_000,
  /** One list page. */
  page: 1000,
  /** Contacts per bulk action. */
  batch: 500,
  /** A .vcf or .csv import, before JSON encoding. */
  importBytes: 900 * 1024,
  importContacts: 2000,
} as const;

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/[\r\n]/u.test(value), "Use a single line.");

const emailAddressSchema = z
  .string()
  .trim()
  .max(254)
  .regex(
    /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/u,
    "Enter a valid email address.",
  );

export const contactEmailSchema = z.object({
  type: z.enum(CONTACT_EMAIL_TYPES),
  value: emailAddressSchema,
});
export type ContactEmail = z.infer<typeof contactEmailSchema>;

export const contactPhoneSchema = z.object({
  type: z.enum(CONTACT_PHONE_TYPES),
  value: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[0-9+()#*.,;\-\s/xX]+$/u, "Use digits, spaces and + ( ) - only."),
});
export type ContactPhone = z.infer<typeof contactPhoneSchema>;

export const contactAddressSchema = z
  .object({
    type: z.enum(CONTACT_ADDRESS_TYPES),
    street: singleLine(CONTACT_LIMITS.text),
    city: singleLine(CONTACT_LIMITS.name),
    region: singleLine(CONTACT_LIMITS.name),
    postalCode: singleLine(40),
    country: singleLine(CONTACT_LIMITS.name),
  })
  .refine(
    (address) =>
      [address.street, address.city, address.region, address.postalCode, address.country].some(
        (part) => part.length > 0,
      ),
    "An address needs at least one line.",
  );
export type ContactAddress = z.infer<typeof contactAddressSchema>;

/** `YYYY-MM-DD`, or `--MM-DD` when the year is unknown. */
export const contactBirthdaySchema = z
  .string()
  .regex(/^(?:\d{4}-|--)(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u, "Use YYYY-MM-DD.");

export const contactLabelNameSchema = z
  .string()
  .trim()
  .min(1, "Name the label.")
  .max(CONTACT_LIMITS.labelName)
  .refine((value) => !/[\r\n,;\\]/u.test(value), "Labels cannot contain commas or semicolons.");

export const contactPhotoSchema = z
  .string()
  .max(CONTACT_LIMITS.photoBytes)
  .regex(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u,
    "Use a PNG, JPEG or WebP picture.",
  );

/** Every editable field of a contact. */
export const contactFieldsSchema = z.object({
  givenName: singleLine(CONTACT_LIMITS.name).default(""),
  familyName: singleLine(CONTACT_LIMITS.name).default(""),
  company: singleLine(CONTACT_LIMITS.name).default(""),
  jobTitle: singleLine(CONTACT_LIMITS.name).default(""),
  emails: z.array(contactEmailSchema).max(CONTACT_LIMITS.entries).default([]),
  phones: z.array(contactPhoneSchema).max(CONTACT_LIMITS.entries).default([]),
  addresses: z.array(contactAddressSchema).max(CONTACT_LIMITS.entries).default([]),
  birthday: contactBirthdaySchema.nullable().default(null),
  notes: z.string().max(CONTACT_LIMITS.notes).default(""),
  labels: z.array(contactLabelNameSchema).max(CONTACT_LIMITS.labels).default([]),
  photoDataUrl: contactPhotoSchema.nullable().default(null),
  starred: z.boolean().default(false),
});
export type ContactFields = z.infer<typeof contactFieldsSchema>;
export type ContactFieldsInput = z.input<typeof contactFieldsSchema>;
/** A partial edit: given fields replace the stored value. */
export type ContactPatch = { readonly [K in keyof ContactFields]?: ContactFields[K] | undefined };

/** A contact needs a name, a company, an email or a phone to be findable. */
export function contactHasIdentity(fields: {
  readonly givenName: string;
  readonly familyName: string;
  readonly company: string;
  readonly emails: readonly unknown[];
  readonly phones: readonly unknown[];
}): boolean {
  return (
    fields.givenName.trim().length > 0 ||
    fields.familyName.trim().length > 0 ||
    fields.company.trim().length > 0 ||
    fields.emails.length > 0 ||
    fields.phones.length > 0
  );
}

const identityMessage = "Add a name, company, email or phone.";

/**
 * A stored contact. Values written by other CardDAV clients are shown as they
 * are, so entries are plain strings here; edits are validated on input.
 */
export const contactSchema = contactFieldsSchema.extend({
  emails: z.array(z.object({ type: z.enum(CONTACT_EMAIL_TYPES), value: z.string() })),
  phones: z.array(z.object({ type: z.enum(CONTACT_PHONE_TYPES), value: z.string() })),
  addresses: z.array(
    z.object({
      type: z.enum(CONTACT_ADDRESS_TYPES),
      street: z.string(),
      city: z.string(),
      region: z.string(),
      postalCode: z.string(),
      country: z.string(),
    }),
  ),
  id: z.string().uuid(),
  /** The vCard FN: the name people see. */
  displayName: z.string(),
  /** The org member with this contact's primary email, for Chat. */
  memberActorId: z.string().uuid().nullable(),
  updatedAt: z.string(),
  /** Set while the contact is in Trash. */
  deletedAt: z.string().nullable(),
});
export type Contact = z.infer<typeof contactSchema>;

const contactIdSchema = z.string().uuid();
const contactIdsSchema = z.array(contactIdSchema).min(1).max(CONTACT_LIMITS.batch);

export const contactListInputSchema = z
  .object({
    /** `trash` lists contacts deleted in the last 30 days. */
    view: z.enum(["contacts", "trash"]).default("contacts"),
    label: contactLabelNameSchema.optional(),
    /** Matches names, company, emails and phone numbers. */
    query: z.string().trim().max(200).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(CONTACT_LIMITS.page).default(CONTACT_LIMITS.page),
  })
  .strict();
export const contactListResultSchema = z.object({
  contacts: z.array(contactSchema),
  total: z.number().int(),
});
export type ContactListResult = z.infer<typeof contactListResultSchema>;

export const contactGetInputSchema = z.object({ id: contactIdSchema }).strict();
export const contactResultSchema = z.object({ contact: contactSchema });

export const contactCreateInputSchema = contactFieldsSchema
  .strict()
  .refine(contactHasIdentity, identityMessage);

/** Replaces the fields given; omitted fields keep their value. */
export const contactUpdateInputSchema = contactFieldsSchema
  .partial()
  .extend({ id: contactIdSchema })
  .strict();

export const contactIdsInputSchema = z.object({ ids: contactIdsSchema }).strict();
export const contactIdsResultSchema = z.object({ ids: z.array(contactIdSchema) });

export const contactLabelApplyInputSchema = z
  .object({
    ids: contactIdsSchema,
    add: z.array(contactLabelNameSchema).max(CONTACT_LIMITS.labels).default([]),
    remove: z.array(contactLabelNameSchema).max(CONTACT_LIMITS.labels).default([]),
  })
  .strict()
  .refine(
    (input) => input.add.length + input.remove.length > 0,
    "Choose a label to add or remove.",
  );

export const contactLabelSchema = z.object({
  name: z.string(),
  /** Contacts (not in Trash) carrying the label. */
  count: z.number().int(),
});
export type ContactLabel = z.infer<typeof contactLabelSchema>;
export const contactLabelListInputSchema = z.object({}).strict();
export const contactLabelListResultSchema = z.object({
  labels: z.array(contactLabelSchema),
  /** Contacts not in Trash. */
  total: z.number().int(),
});
export type ContactLabelListResult = z.infer<typeof contactLabelListResultSchema>;
export const contactLabelCreateInputSchema = z.object({ name: contactLabelNameSchema }).strict();
export const contactLabelRenameInputSchema = z
  .object({ name: contactLabelNameSchema, newName: contactLabelNameSchema })
  .strict();
/** Deleting a label keeps its contacts; only the label is removed from them. */
export const contactLabelDeleteInputSchema = z.object({ name: contactLabelNameSchema }).strict();
export const contactLabelResultSchema = z.object({ label: contactLabelSchema });

export const CONTACT_IMPORT_FORMATS = ["vcard", "csv"] as const;
export const contactImportInputSchema = z
  .object({
    format: z.enum(CONTACT_IMPORT_FORMATS),
    content: z
      .string()
      .min(1, "The file is empty.")
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= CONTACT_LIMITS.importBytes,
        "The file is larger than 900 KB. Split it and import each part.",
      ),
    /** Validate and count without saving. */
    dryRun: z.boolean().default(false),
    /** Added to every imported contact, e.g. "Imported 10/11". */
    label: contactLabelNameSchema.optional(),
  })
  .strict();
export const contactImportResultSchema = z.object({
  /** Contacts that are valid and were (or would be) imported. */
  count: z.number().int(),
  /** Entries that could not be read, with the reason for the first few. */
  skipped: z.number().int(),
  problems: z.array(z.string()).max(10),
  /** Up to five display names, for the preview. */
  sample: z.array(z.string()).max(5),
  imported: z.boolean(),
});
export type ContactImportResult = z.infer<typeof contactImportResultSchema>;

export const contactExportInputSchema = z
  .object({
    /** Omit to export every contact (not in Trash). */
    ids: contactIdsSchema.optional(),
    label: contactLabelNameSchema.optional(),
  })
  .strict();
export const contactExportResultSchema = z.object({
  filename: z.string(),
  /** vCard 3.0/4.0 cards as stored, concatenated. */
  vcard: z.string(),
  count: z.number().int(),
});
export type ContactExportResult = z.infer<typeof contactExportResultSchema>;

export const contactDuplicateGroupSchema = z.object({
  /** What the contacts share. */
  reason: z.enum(["email", "phone"]),
  value: z.string(),
  contacts: z.array(contactSchema).min(2),
});
export type ContactDuplicateGroup = z.infer<typeof contactDuplicateGroupSchema>;
export const contactDuplicateListInputSchema = z.object({}).strict();
export const contactDuplicateListResultSchema = z.object({
  groups: z.array(contactDuplicateGroupSchema),
});

/** Folds each source into the target; sources move to Trash. */
export const contactMergeInputSchema = z
  .object({
    targetId: contactIdSchema,
    sourceIds: z.array(contactIdSchema).min(1).max(20),
  })
  .strict()
  .refine(
    (input) => !input.sourceIds.includes(input.targetId),
    "Pick different contacts to merge.",
  );

/** An org member as listed in Directory. */
export const directoryMemberSchema = z.object({
  actorId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  jobTitle: z.string().nullable(),
  avatarDataUrl: z.string().nullable(),
});
export type DirectoryMember = z.infer<typeof directoryMemberSchema>;
export const directoryListInputSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(CONTACT_LIMITS.page).default(CONTACT_LIMITS.page),
  })
  .strict();
export const directoryListResultSchema = z.object({
  members: z.array(directoryMemberSchema),
  total: z.number().int(),
});
export type DirectoryListResult = z.infer<typeof directoryListResultSchema>;
