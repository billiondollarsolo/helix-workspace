import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actors } from "./auth.js";
import { timestamps } from "./common.js";
import { threads } from "./messages.js";

export const calCalendars = pgTable(
  "cal_calendars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id")
      .references(() => actors.id)
      .notNull(),
    name: text("name").notNull(),
    color: text("color"),
    timezone: text("timezone").default("UTC").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").default({}).notNull(),
    syncVersion: bigint("sync_version", { mode: "number" }).default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    ownerIdx: index("cal_calendars_owner_idx").on(table.ownerActorId, table.deletedAt),
    orgIdx: index("cal_calendars_org_idx").on(table.orgId),
    syncVersionCheck: check(
      "cal_calendars_sync_version_nonnegative",
      sql`${table.syncVersion} >= 0`,
    ),
  }),
);

export const calEventChanges = pgTable(
  "cal_event_changes",
  {
    orgId: uuid("org_id").notNull(),
    calendarId: uuid("calendar_id").notNull(),
    syncVersion: bigint("sync_version", { mode: "number" }).notNull(),
    eventId: uuid("event_id").notNull(),
    deleted: boolean("deleted").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.calendarId, table.syncVersion] }),
    calendarFk: foreignKey({
      columns: [table.orgId, table.calendarId],
      foreignColumns: [calCalendars.orgId, calCalendars.id],
    }).onDelete("cascade"),
    orgCalendarVersionIdx: index("cal_event_changes_org_calendar_version_idx").on(
      table.orgId,
      table.calendarId,
      table.syncVersion,
    ),
    syncVersionCheck: check("cal_event_changes_sync_version_check", sql`${table.syncVersion} > 0`),
  }),
);

export const calEvents = pgTable(
  "cal_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    calendarId: uuid("calendar_id")
      .references(() => calCalendars.id, { onDelete: "cascade" })
      .notNull(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    uid: text("uid").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    allDay: boolean("all_day").default(false).notNull(),
    timeSemantics: text("time_semantics").default("zoned").notNull(),
    startsLocal: text("starts_local").notNull(),
    endsLocal: text("ends_local").notNull(),
    status: text("status").default("confirmed").notNull(),
    recurrenceRule: text("recurrence_rule"),
    organizerActorId: uuid("organizer_actor_id").references(() => actors.id),
    organizerEmail: text("organizer_email"),
    icsSequence: integer("ics_sequence").default(0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    calendarTimeIdx: index("cal_events_calendar_time_idx").on(
      table.calendarId,
      table.startsAt,
      table.endsAt,
    ),
    orgTimeIdx: index("cal_events_org_time_idx").on(table.orgId, table.startsAt, table.endsAt),
    organizerIdx: index("cal_events_organizer_idx").on(table.organizerActorId),
  }),
);

export const calEventRevisions = pgTable(
  "cal_event_revisions",
  {
    orgId: uuid("org_id").notNull(),
    eventId: uuid("event_id").notNull(),
    revision: integer("revision").notNull(),
    calendarId: uuid("calendar_id").notNull(),
    changeKind: text("change_kind").notNull(),
    changedByActorId: uuid("changed_by_actor_id"),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.eventId, table.revision] }),
    orgCalendarCreatedIdx: index("cal_event_revisions_org_calendar_created_idx").on(
      table.orgId,
      table.calendarId,
      table.createdAt,
      table.eventId,
      table.revision,
    ),
  }),
);

export const calSchedulingProfiles = pgTable(
  "cal_scheduling_profiles",
  {
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    timezone: text("timezone").default("UTC").notNull(),
    workDays: integer("work_days").array().default([1, 2, 3, 4, 5]).notNull(),
    workStart: time("work_start").default("09:00").notNull(),
    workEnd: time("work_end").default("17:00").notNull(),
    workLocation: text("work_location"),
    externalAvailability: text("external_availability").default("none").notNull(),
    holidayCalendarId: uuid("holiday_calendar_id").references(() => calCalendars.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.actorId] }),
  }),
);

export const calResources = pgTable(
  "cal_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calCalendars.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    capacity: integer("capacity"),
    approvalPolicy: text("approval_policy").default("auto").notNull(),
    approverActorId: uuid("approver_actor_id").references(() => actors.id, {
      onDelete: "restrict",
    }),
    active: boolean("active").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdIdIdx: uniqueIndex("cal_resources_org_id_id_idx").on(table.orgId, table.id),
    orgCalendarIdx: uniqueIndex("cal_resources_org_calendar_idx").on(table.orgId, table.calendarId),
    orgKindIdx: index("cal_resources_org_kind_idx").on(
      table.orgId,
      table.kind,
      table.active,
      table.name,
    ),
  }),
);

export const calResourceBookings = pgTable(
  "cal_resource_bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => calEvents.id, { onDelete: "cascade" }),
    recurrenceId: timestamp("recurrence_id", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    requestedByActorId: uuid("requested_by_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    decidedByActorId: uuid("decided_by_actor_id").references(() => actors.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    resourceFk: foreignKey({
      columns: [table.orgId, table.resourceId],
      foreignColumns: [calResources.orgId, calResources.id],
      name: "cal_resource_bookings_resource_org_fk",
    }).onDelete("cascade"),
    occurrenceIdx: uniqueIndex("cal_resource_bookings_occurrence_idx").on(
      table.orgId,
      table.eventId,
      table.resourceId,
      table.startsAt,
    ),
    eventIdx: index("cal_resource_bookings_event_idx").on(table.orgId, table.eventId),
  }),
);

export const calAttendees = pgTable(
  "cal_attendees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    eventId: uuid("event_id")
      .references(() => calEvents.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role").default("required").notNull(),
    responseStatus: text("response_status").default("needs_action").notNull(),
    isOrganizer: boolean("is_organizer").default(false).notNull(),
    rsvpToken: text("rsvp_token").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    rsvpTokenIdx: uniqueIndex("cal_attendees_rsvp_token_idx").on(table.rsvpToken),
    actorIdx: index("cal_attendees_actor_idx").on(table.actorId),
    eventIdx: index("cal_attendees_event_idx").on(table.eventId),
  }),
);

export const cardDavAddressBooks = pgTable(
  "carddav_addressbooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id")
      .notNull()
      .references(() => actors.id, {
        onDelete: "cascade",
      }),
    displayName: text("display_name").default("Contacts").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    ...timestamps,
  },
  (table) => ({
    ownerIdx: index("carddav_addressbooks_owner_idx").on(table.orgId, table.ownerActorId, table.id),
  }),
);

export const cardDavContacts = pgTable(
  "carddav_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id")
      .notNull()
      .references(() => actors.id, {
        onDelete: "cascade",
      }),
    addressBookId: uuid("addressbook_id")
      .notNull()
      .references(() => cardDavAddressBooks.id, {
        onDelete: "cascade",
      }),
    href: text("href").notNull(),
    uid: text("uid").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    favorite: boolean("favorite").default(false).notNull(),
    avatarDataUrl: text("avatar_data_url"),
    relationship: jsonb("relationship").default({}).notNull(),
    mergedIntoId: uuid("merged_into_id"),
    vcard: text("vcard").notNull(),
    etag: text("etag").notNull(),
    syncVersion: bigint("sync_version", { mode: "number" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    legalHold: boolean("legal_hold").default(false).notNull(),
    ...timestamps,
  },
  (table) => ({
    ownerFavoriteIdx: index("carddav_contacts_owner_favorite_idx").on(
      table.orgId,
      table.ownerActorId,
      table.favorite,
      table.displayName,
    ),
  }),
);
