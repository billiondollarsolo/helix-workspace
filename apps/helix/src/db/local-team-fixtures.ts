import { createHash } from "node:crypto";
import type { Permission } from "../platform/permissions/scope-catalog.js";

export const LOCAL_TEAM_SOURCE = "local-team-demo-v1";
export const LOCAL_TEAM_PASSWORD = "helix-team-demo-password";
export const LOCAL_TEAM_DOMAINS = ["helix.local", "harbor.local"] as const;

/** Existing login-seed admin; team content grants this actor in, and never recreates the account. */
export const LOCAL_TEAM_ADMIN = {
  actorId: "00000000-0000-4000-8000-000000000110",
  email: "admin@helix.local",
  aliases: ["admin@harbor.local", "avery.park@harbor.local"],
  displayName: "Avery Park",
  firstName: "Avery",
  jobTitle: "Workspace admin",
} as const;

/** Reserved fixture namespace; the seed never replaces an existing row. */
export function teamId(category: number, index: number): string {
  return `1${String(category).padStart(7, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export const LOCAL_TEAM_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
  "calendar.manage",
  "calendar.write:respond",
  "chat.read",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "notifications.read",
  "notifications.write",
] as const satisfies readonly Permission[];

const people = [
  [
    "samara",
    "Samara Malik",
    "she/her",
    "Product lead",
    "turning customer problems into clear release decisions",
    "Harbor launch brief",
  ],
  [
    "theo",
    "Theo Brooks",
    "he/him",
    "Platform engineer",
    "reliable APIs and small, observable deployments",
    "Service readiness checklist",
  ],
  [
    "imani",
    "Imani Reed",
    "she/they",
    "Product designer",
    "accessible interfaces and thoughtful empty states",
    "Design review notes",
  ],
  [
    "jun",
    "Jun Park",
    "they/them",
    "Application engineer",
    "fast navigation and dependable collaboration",
    "Collaboration test plan",
  ],
  [
    "elena",
    "Elena Costa",
    "she/her",
    "Customer success lead",
    "practical onboarding and useful customer feedback",
    "Pilot customer playbook",
  ],
  [
    "omar",
    "Omar Haddad",
    "he/him",
    "Operations engineer",
    "restorable backups and calm incident response",
    "Operations handover",
  ],
  [
    "nora",
    "Nora Patel",
    "she/her",
    "User researcher",
    "turning interviews into evidence for product decisions",
    "Pilot research synthesis",
  ],
  [
    "luca",
    "Luca Rossi",
    "he/they",
    "Finance partner",
    "clear budgets and sustainable team planning",
    "Pilot budget forecast",
  ],
  [
    "priya",
    "Priya Shah",
    "she/her",
    "Security engineer",
    "least privilege and repeatable security reviews",
    "Access review checklist",
  ],
  [
    "mateo",
    "Mateo Silva",
    "he/him",
    "Communications lead",
    "plain-language launch stories and helpful documentation",
    "Launch communications plan",
  ],
] as const;

export const LOCAL_TEAM_PEOPLE = people.map(
  ([key, displayName, pronouns, jobTitle, focus, documentTitle], index) => {
    const firstName = displayName.split(" ")[0] ?? displayName;
    const lastName = displayName.split(" ").at(-1)?.toLowerCase() ?? key;
    return {
      index,
      actorId: teamId(0, index + 1),
      email: `demo.${key}@helix.local`,
      aliases: [
        `${key}@harbor.local`,
        `${firstName.toLowerCase()}.${lastName}@harbor.local`,
        ...(index % 3 === 0 ? [`${firstName.toLowerCase()}.${lastName}@helix.local`] : []),
      ],
      firstName,
      displayName,
      pronouns,
      jobTitle,
      focus,
      documentTitle,
      about: `I work on ${focus}. For the Harbor pilot I am preparing ${documentTitle.toLowerCase()}. Happy to review a draft or pair on a difficult problem.`,
      folderId: teamId(1, index + 1),
      calendarId: teamId(5, index + 1),
    };
  },
);
export type TeamPerson = (typeof LOCAL_TEAM_PEOPLE)[number];

export const LOCAL_TEAM_DIRECT_MESSAGES = LOCAL_TEAM_PEOPLE.map((person) => {
  const members = [person.index, (person.index + 1) % LOCAL_TEAM_PEOPLE.length];
  return {
    id: teamId(3, person.index + 101),
    members,
    participantKey: createHash("sha256")
      .update(
        members
          .map((index) => teamPerson(index).actorId)
          .sort()
          .join(","),
      )
      .digest("hex"),
  };
});

export const LOCAL_TEAM_GROUPS = [
  {
    id: teamId(8, 1),
    name: "Harbor product crew",
    members: [0, 2, 4, 6, 9],
    description: "Product, research, design, and customer communication.",
  },
  {
    id: teamId(8, 2),
    name: "Harbor engineering crew",
    members: [1, 3, 5, 8],
    description: "Application reliability, operations, and access review.",
  },
  {
    id: teamId(8, 3),
    name: "Harbor planning partners",
    members: [0, 4, 7, 9],
    description: "Pilot scope, budget, and launch coordination.",
  },
] as const;

export const LOCAL_TEAM_ROOMS = [
  {
    id: teamId(3, 1),
    name: "Harbor team lounge",
    members: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    includeAdmin: true,
    topic: "Daily check-ins, useful discoveries, and Friday demos.",
  },
  {
    id: teamId(3, 2),
    name: "Harbor engineering",
    members: [1, 3, 5, 8],
    includeAdmin: false,
    topic: "Deployment readiness, observability, and access boundaries.",
  },
  {
    id: teamId(3, 3),
    name: "Harbor launch decisions",
    members: [0, 1, 2],
    includeAdmin: true,
    topic: "Private working room for pilot scope and design decisions.",
  },
  {
    id: teamId(3, 4),
    name: "Harbor budget planning",
    members: [0, 7],
    includeAdmin: false,
    topic: "Private pilot forecast and spend review.",
  },
  {
    id: teamId(3, 5),
    name: "Harbor customer feedback",
    members: [4, 6, 9],
    includeAdmin: true,
    topic: "Interview synthesis, customer questions, and launch guidance.",
  },
] as const;

export function teamDay(anchorDate: string, dayOffset: number, hour = 14): Date {
  const date = new Date(`${anchorDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== anchorDate) {
    throw new Error("Team seed anchor date must be a valid YYYY-MM-DD.");
  }
  date.setUTCDate(date.getUTCDate() + dayOffset);
  date.setUTCHours(hour);
  return date;
}

export function teamPerson(index: number): TeamPerson {
  const person = LOCAL_TEAM_PEOPLE[index];
  if (!person) throw new RangeError(`Unknown team fixture person: ${String(index)}`);
  return person;
}
