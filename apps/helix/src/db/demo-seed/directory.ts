import { hashPassword } from "better-auth/crypto";
import { PostgresAccountPreferencesStore } from "../../platform/auth/account-preferences.js";
import { WORKSPACE_MEMBER_SCOPES } from "../../platform/auth/member-scopes.js";
import type { Permission } from "../../platform/permissions/scope-catalog.js";
import {
  COMPANY,
  DEPARTMENTS,
  UMBRELLA_ORG_UNITS,
  activePeople,
  type DepartmentKey,
  type Person,
} from "./company.js";
import { avatarPng, pngDataUrl } from "./files.js";
import { SeedRandom, TIME } from "./random.js";
import { DemoSeedError, type DemoRuntime } from "./runtime.js";

export const ADMIN_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "mail.external",
  "mail.admin",
  "drive.read",
  "drive.write",
  "drive.delete",
  "calendar.read",
  "calendar.write",
  "calendar.manage",
  "calendar.external",
  "chat.read",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "contacts.read",
  "contacts.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "notifications.read",
  "notifications.write",
  "tools:read",
  "tools:write",
  "admin.users",
  "admin.audit",
  "admin.agents",
  "admin.plugins",
  "admin.webhooks",
  "admin.config.read",
  "admin.config.write",
  "admin.console.read",
  "admin.console.write",
  "admin.ai",
  "admin.chat",
  "admin.drive",
  // The demo administrator is the workspace's global administrator.
  "admin.*",
] as const satisfies readonly Permission[];

const MEMBER_SCOPES = WORKSPACE_MEMBER_SCOPES;

export interface DirectoryGroup {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly memberIds: readonly string[];
}

export interface Directory {
  readonly people: readonly Person[];
  readonly byKey: ReadonlyMap<string, Person>;
  readonly groups: ReadonlyMap<string, DirectoryGroup>;
}

/**
 * Creates every person as a tenant actor with a real Better Auth credential
 * and identity membership (the same rows a sign-up or SCIM invite plus first
 * sign-in produce), then fills in profiles, photos and working hours.
 */
export async function seedPeople(runtime: DemoRuntime, roster: readonly Person[]): Promise<void> {
  const hashes = new Map<string, string>();
  for (const password of new Set(roster.map((person) => person.password))) {
    hashes.set(password, await hashPassword(password));
  }
  const preferences = new PostgresAccountPreferencesStore(runtime.sql);
  for (const person of roster) {
    await runtime.tenant(async (tx) => {
      await tx`
        insert into actors (id, org_id, type, email, display_name, scopes, metadata)
        values (
          ${person.actorId}, ${runtime.orgId}, 'user', ${person.email}, ${person.displayName},
          ${tx.array([...(person.isAdmin ? ADMIN_SCOPES : MEMBER_SCOPES)], 1009)},
          ${tx.json({ givenName: person.givenName, familyName: person.familyName })}
        )
      `;
      if (person.status === "invited") return;
      const userId = `demo-${person.actorId}`;
      await tx`
        insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${userId}, ${person.displayName}, ${person.email}, true, now(), now())
      `;
      await tx`
        insert into account (id, "userId", "accountId", "providerId", issuer, password, "createdAt", "updatedAt")
        values (${`${userId}-credential`}, ${userId}, ${userId}, 'credential', 'local:credential',
          ${hashes.get(person.password) ?? ""}, now(), now())
      `;
      const linked = await tx<{ readonly actor_id: string | null }[]>`
        select helix_activate_identity_membership(
          'better-auth', ${userId}, ${runtime.orgId}, ${person.email}, ${person.displayName}
        ) as actor_id
      `;
      if (linked[0]?.actor_id !== person.actorId) {
        throw new DemoSeedError(
          `Sign-in for ${person.email} did not link to its workspace account. Another login may already use that address; run with --reset.`,
        );
      }
      runtime.chronology.at("user", { id: userId }, joined(runtime, person));
    });
    await runtime.tenant(async () => {
      await runtime.profiles.update(runtime.orgId, person.actorId, {
        pronouns: person.pronouns,
        jobTitle: person.jobTitle,
        about: aboutText(person),
        avatarDataUrl: pngDataUrl(avatarPng(person.key)),
      });
    });
    runtime.chronology.at(
      "actors",
      { id: person.actorId },
      {
        created_at: joined(runtime, person).createdAt,
        updated_at: new Date(runtime.timeline.now.getTime() - (person.tenureDays % 37) * TIME.DAY),
      },
    );
    if (person.status === "active") {
      await preferences.set({
        orgId: runtime.orgId,
        actorId: person.actorId,
        timeZone: person.location.includes("Lisbon") ? "Europe/Lisbon" : timeZoneFor(person),
        workingHours: workingHours(person),
        weekStart: 1,
      });
    }
  }
}

function joined(runtime: DemoRuntime, person: Person) {
  const createdAt = new Date(runtime.timeline.now.getTime() - person.tenureDays * TIME.DAY);
  createdAt.setUTCHours(14, person.index % 60, 0, 0);
  return { createdAt, updatedAt: createdAt };
}

function timeZoneFor(person: Person): string {
  if (person.location.includes("Denver")) return "America/Denver";
  if (person.location.includes("Austin")) return "America/Chicago";
  if (person.location.includes("Toronto")) return "America/Toronto";
  return COMPANY.timezone;
}

function workingHours(person: Person) {
  const random = SeedRandom.stream("hours", person.key);
  const start = random.pick(["08:00", "08:30", "09:00", "09:30", "10:00"]);
  const end = start < "09:00" ? "16:30" : random.pick(["17:00", "17:30", "18:00"]);
  const days =
    person.status === "active" && person.index % 11 === 4 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
  return { enabled: true, days: days.map((day) => ({ day, start, end })) };
}

function aboutText(person: Person): string {
  const department = DEPARTMENTS.find((entry) => entry.key === person.department);
  const lines = [
    `${person.jobTitle} on the ${person.team} team (${department?.name ?? person.department}).`,
    `Based in ${person.location.replace("Remote — ", "")}.`,
  ];
  if (person.department === "support") lines.push("Ask me about escalations and the help center.");
  if (person.department === "engineering")
    lines.push(`Happy to pair on anything ${person.team.toLowerCase()}.`);
  return lines.join(" ");
}

/** Company-domain aliases for the two `helix.local` sign-in accounts. */
export async function seedAliases(runtime: DemoRuntime, roster: readonly Person[]): Promise<void> {
  for (const person of roster) {
    for (const alias of person.aliases) {
      await runtime.mail.createAlias({
        orgId: runtime.orgId,
        actorId: person.actorId,
        email: alias,
        displayName: person.displayName,
        receiveEnabled: true,
        sendAsEnabled: true,
      });
    }
  }
}

interface GroupSpec {
  readonly key: string;
  readonly name: string;
  readonly local: string | null;
  readonly kind: "group" | "security" | "mailing_list";
  readonly postingPolicy: "organization" | "anyone";
  readonly description: string;
  readonly orgUnit: string | null;
  readonly members: (person: Person) => boolean;
}

function groupSpecs(): readonly GroupSpec[] {
  const department = (key: DepartmentKey) => (person: Person) => person.department === key;
  const team: GroupSpec[] = DEPARTMENTS.filter((entry) => entry.key !== "leadership").map(
    (entry) => ({
      key: `dept-${entry.key}`,
      name: `${entry.name} team`,
      local: entry.key === "support" || entry.key === "sales" ? null : entry.key,
      kind: "group",
      postingPolicy: "organization",
      description: `Everyone in ${entry.name}. Used for team calendars, Drive folders and chat spaces.`,
      orgUnit: entry.orgUnit,
      members: department(entry.key),
    }),
  );
  return [
    {
      key: "all-staff",
      name: "All staff",
      local: "all-staff",
      kind: "mailing_list",
      postingPolicy: "organization",
      description: "Every current employee. Company-wide announcements only, please.",
      orgUnit: null,
      members: () => true,
    },
    {
      key: "leadership",
      name: "Leadership team",
      local: "leadership",
      kind: "group",
      postingPolicy: "organization",
      description: "Department heads and the executive team.",
      orgUnit: "Leadership",
      members: (person) => person.managerKey === "person-0" || person.key === "person-0",
    },
    ...team,
    {
      key: "support-inbox",
      name: "Customer support",
      local: "support",
      kind: "mailing_list",
      postingPolicy: "anyone",
      description: "Shared inbox for customer questions. Replies go out as the support team.",
      orgUnit: "Customer Support",
      members: department("support"),
    },
    {
      key: "sales-inbox",
      name: "Sales enquiries",
      local: "sales",
      kind: "mailing_list",
      postingPolicy: "anyone",
      description: "Inbound pricing and demo requests from the website.",
      orgUnit: "Sales",
      members: department("sales"),
    },
    {
      key: "billing",
      name: "Billing and invoices",
      local: "billing",
      kind: "mailing_list",
      postingPolicy: "anyone",
      description: "Vendor invoices and receipts. Finance processes everything sent here weekly.",
      orgUnit: "Finance",
      members: department("finance"),
    },
    {
      key: "careers",
      name: "Careers",
      local: "careers",
      kind: "mailing_list",
      postingPolicy: "anyone",
      description: "Candidate replies and recruiting agencies.",
      orgUnit: "People",
      members: department("people"),
    },
    {
      key: "workspace-admins",
      name: "Workspace administrators",
      local: null,
      kind: "security",
      postingPolicy: "organization",
      description: "Can change workspace settings, domains and security policy.",
      orgUnit: "IT & Workplace",
      members: (person) => person.isAdmin,
    },
    {
      key: "incident-response",
      name: "Incident response",
      local: null,
      kind: "security",
      postingPolicy: "organization",
      description: "On-call engineers and the security lead. Access to restricted runbooks.",
      orgUnit: "Engineering",
      members: (person) =>
        person.department === "engineering" &&
        /Reliability|Security|Staff|VP/u.test(person.jobTitle),
    },
    {
      key: "book-club",
      name: "Book club",
      local: "book-club",
      kind: "group",
      postingPolicy: "organization",
      description: "One book a month, discussed over lunch on the last Thursday.",
      orgUnit: null,
      members: (person) => person.index % 6 === 1,
    },
    {
      key: "running-club",
      name: "Running club",
      local: null,
      kind: "group",
      postingPolicy: "organization",
      description: "Tuesday and Saturday runs from the Providence office.",
      orgUnit: null,
      members: (person) => person.index % 7 === 3,
    },
  ];
}

/** Org-unit tree, then groups and distribution lists with their members. */
export async function seedOrgStructure(
  runtime: DemoRuntime,
  roster: readonly Person[],
  adminActorId: string,
): Promise<ReadonlyMap<string, DirectoryGroup>> {
  const units = new Map<string, string>();
  const unitSpecs = [
    ...UMBRELLA_ORG_UNITS.map((name) => ({ name, parent: null as string | null })),
    ...DEPARTMENTS.map((entry) => ({ name: entry.orgUnit, parent: entry.parentOrgUnit })),
  ].sort((left, right) => Number(left.parent !== null) - Number(right.parent !== null));
  for (const unit of unitSpecs) {
    const created = await runtime.groups.createOrgUnit({
      orgId: runtime.orgId,
      parentId: unit.parent === null ? null : (units.get(unit.parent) ?? null),
      name: unit.name,
      description: `${unit.name} at ${COMPANY.name}.`,
      createdBy: adminActorId,
    });
    units.set(unit.name, created.id);
    runtime.chronology.at(
      "admin_org_units",
      { id: created.id },
      {
        created_at: runtime.timeline.start,
        updated_at: runtime.timeline.start,
      },
    );
  }
  const current = activePeople(roster);
  const groups = new Map<string, DirectoryGroup>();
  for (const spec of groupSpecs()) {
    const email = spec.local === null ? null : `${spec.local}@${COMPANY.domain}`;
    const group = await runtime.groups.createGroup({
      orgId: runtime.orgId,
      name: spec.name,
      email,
      kind: spec.kind,
      postingPolicy: spec.postingPolicy,
      description: spec.description,
      orgUnitId: spec.orgUnit === null ? null : (units.get(spec.orgUnit) ?? null),
      createdBy: adminActorId,
    });
    const members = current.filter(spec.members);
    for (const [position, member] of members.entries()) {
      await runtime.groups.addGroupMember({
        orgId: runtime.orgId,
        groupId: group.id,
        actorId: member.actorId,
        role: position === 0 ? "owner" : member.managerKey === "person-0" ? "manager" : "member",
        addedBy: adminActorId,
      });
    }
    const createdAt = new Date(runtime.timeline.start.getTime() + (groups.size + 1) * 3 * TIME.DAY);
    runtime.chronology.at(
      "admin_groups",
      { id: group.id },
      { created_at: createdAt, updated_at: createdAt },
    );
    groups.set(spec.key, {
      key: spec.key,
      id: group.id,
      name: spec.name,
      email,
      memberIds: members.map((member) => member.actorId),
    });
  }
  return groups;
}
