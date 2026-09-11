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

export const LOCAL_TEAM_SHARED_FOLDERS = [
  {
    id: teamId(1, 101),
    name: "Harbor team resources",
    owner: 0,
    members: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    includeAdmin: true,
  },
  {
    id: teamId(1, 102),
    name: "Harbor private launch working files",
    owner: 0,
    members: [0, 1, 2],
    includeAdmin: true,
  },
  {
    id: teamId(1, 103),
    name: "Harbor engineering handover",
    owner: 1,
    members: [1, 3, 5, 8],
    includeAdmin: true,
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

export function teamFileFixtures() {
  const personal = LOCAL_TEAM_PEOPLE.flatMap((person) => [
    {
      key: `${String(person.index)}-brief`,
      owner: person,
      folderId: person.folderId,
      name: `${person.documentTitle}.md`,
      mimeType: "text/markdown",
      body: `# ${person.documentTitle}\n\nOwner: ${person.displayName}, ${person.jobTitle}\nProject: Harbor pilot\n\n## Outcome\nHelp a ten-person team coordinate customer work without losing decisions across Mail, Drive, and Chat.\n\n## This week\n- Review the latest customer feedback with Elena and Nora.\n- Check ${person.focus}.\n- Bring one concrete improvement to the Thursday readiness review.\n\n## Acceptance checks\n- Every change has an owner and a clear next step.\n- Private working files are shared only with the intended people.\n- The handover includes a rollback plan and a useful example.\n\n## Open question\nWhich small change would save a teammate the most time?\n`,
    },
    {
      key: `${String(person.index)}-tasks`,
      owner: person,
      folderId: person.folderId,
      name: "Weekly priorities.csv",
      mimeType: "text/csv",
      body: `priority,task,owner,status\n1,Finish ${person.documentTitle},${person.displayName},in progress\n2,Review pilot feedback,${person.displayName},ready\n3,Share Thursday update,${person.displayName},planned\n`,
    },
    {
      key: `${String(person.index)}-notes`,
      owner: person,
      folderId: null,
      name: `${person.firstName}'s working notes.txt`,
      mimeType: "text/plain",
      body: `${person.displayName} — personal working notes\n\nMy focus: ${person.focus}.\n\nMonday: agree on the smallest useful pilot.\nTuesday: collect evidence, including a successful test and a useful failure.\nWednesday: ask another team member to try the flow.\nThursday: review readiness together.\nFriday: document what we learned.\n\nPrivate reminder: keep this file personal until the draft is ready.\n`,
    },
  ]);
  const owner = teamPerson(0);
  return [
    ...personal,
    {
      key: "shared-handbook",
      owner,
      folderId: teamId(1, 101),
      name: "Harbor team handbook.md",
      mimeType: "text/markdown",
      body:
        "# Harbor team handbook\n\nWe run a small customer pilot with ten fictional coworkers.\n\n## Working together\nUse Mail for decisions that need a durable answer. Use Chat for a quick clarification. Keep working documents in Drive and share only with the people who need them.\n\n## Weekly rhythm\nMonday planning, Thursday readiness review, Friday learning notes.\n\n## People\n" +
        LOCAL_TEAM_PEOPLE.map(
          (person) => `- ${person.displayName}: ${person.jobTitle} (${person.email})`,
        ).join("\n") +
        "\n",
    },
    {
      key: "shared-milestones",
      owner,
      folderId: teamId(1, 101),
      name: "Pilot milestones.csv",
      mimeType: "text/csv",
      body: "milestone,owner,status\nScope agreed,Samara Malik,complete\nDesign review,Imani Reed,in progress\nAccess review,Priya Shah,planned\nCustomer rehearsal,Elena Costa,planned\nLaunch note,Mateo Silva,draft\n",
    },
    {
      key: "private-decision",
      owner,
      folderId: teamId(1, 102),
      name: "Pilot scope decision.md",
      mimeType: "text/markdown",
      body: "# Pilot scope decision\n\nPrivate working draft for Samara, Theo, and Imani.\n\nWe will invite a small team first. The acceptance test is a real exchange: send an internal mail, review a shared file, clarify it in Chat, and record the next meeting.\n\nOpen decisions: invitation timing, clear empty states, and how to explain access failures.\n\nDecision owner: Samara. Engineering review: Theo. Design review: Imani.\n",
    },
    {
      key: "engineering-runbook",
      owner: teamPerson(1),
      folderId: teamId(1, 103),
      name: "Pilot operations runbook.md",
      mimeType: "text/markdown",
      body: "# Pilot operations runbook\n\nOwners: Theo, Jun, Omar, and Priya.\n\nBefore a change: verify backup restoration, repeat the permission matrix, and check service health.\nDuring a change: watch delivery errors and request latency.\nAfter a change: try an internal mail, a private room, and a scan-clean file download.\n\nIf a check fails, stop the rollout and keep the previous service version available. Record the failure and its owner in Harbor engineering.\n",
    },
  ];
}

export function teamPerson(index: number): TeamPerson {
  const person = LOCAL_TEAM_PEOPLE[index];
  if (!person) throw new RangeError(`Unknown team fixture person: ${String(index)}`);
  return person;
}
