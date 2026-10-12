import { SeedRandom, seedUuid } from "./random.js";

/**
 * Quillfeather Labs is an invented company: a 2016-era startup that builds
 * "Waypoint", route and shift planning software for regional delivery fleets.
 * Every person, customer and vendor here is fictional; all domains use the
 * RFC 2606 `.example` TLD except the reserved local login domain.
 */
export const COMPANY = {
  name: "Quillfeather Labs",
  slug: "quillfeather",
  domain: "quillfeather.example",
  loginDomain: "helix.local",
  product: "Waypoint",
  timezone: "America/New_York",
  /** Fixed tenant identity: the local default org every runbook and CI job uses. */
  orgId: "00000000-0000-4000-8000-000000000100",
} as const;

const DEMO_PASSWORD = "helix-demo-password";

export type DepartmentKey =
  | "leadership"
  | "engineering"
  | "product"
  | "design"
  | "sales"
  | "support"
  | "marketing"
  | "finance"
  | "people"
  | "legal"
  | "operations";

export interface Department {
  readonly key: DepartmentKey;
  readonly name: string;
  readonly orgUnit: string;
  readonly parentOrgUnit: string | null;
  readonly share: number;
  readonly lead: string;
  readonly titles: readonly string[];
  readonly teams: readonly string[];
}

export const DEPARTMENTS: readonly Department[] = [
  {
    key: "leadership",
    name: "Leadership",
    orgUnit: "Leadership",
    parentOrgUnit: null,
    share: 0,
    lead: "Chief Executive Officer",
    titles: ["Chief Operating Officer", "Chief of Staff"],
    teams: ["Leadership"],
  },
  {
    key: "engineering",
    name: "Engineering",
    orgUnit: "Engineering",
    parentOrgUnit: null,
    share: 30,
    lead: "VP of Engineering",
    titles: [
      "Senior Software Engineer",
      "Software Engineer",
      "Staff Engineer",
      "Engineering Manager",
      "Site Reliability Engineer",
      "QA Engineer",
      "Mobile Engineer",
      "Data Engineer",
      "Security Engineer",
    ],
    teams: ["Platform", "Routing", "Mobile", "Data"],
  },
  {
    key: "product",
    name: "Product",
    orgUnit: "Product",
    parentOrgUnit: null,
    share: 7,
    lead: "Head of Product",
    titles: ["Senior Product Manager", "Product Manager", "Product Analyst"],
    teams: ["Product"],
  },
  {
    key: "design",
    name: "Design",
    orgUnit: "Design",
    parentOrgUnit: "Product",
    share: 6,
    lead: "Design Director",
    titles: ["Product Designer", "Senior Product Designer", "UX Researcher", "Content Designer"],
    teams: ["Design"],
  },
  {
    key: "sales",
    name: "Sales",
    orgUnit: "Sales",
    parentOrgUnit: "Go-to-Market",
    share: 13,
    lead: "VP of Sales",
    titles: [
      "Account Executive",
      "Senior Account Executive",
      "Sales Development Representative",
      "Solutions Consultant",
      "Sales Operations Manager",
    ],
    teams: ["Sales"],
  },
  {
    key: "support",
    name: "Support",
    orgUnit: "Customer Support",
    parentOrgUnit: "Go-to-Market",
    share: 10,
    lead: "Head of Customer Support",
    titles: ["Support Specialist", "Senior Support Specialist", "Support Team Lead"],
    teams: ["Support"],
  },
  {
    key: "marketing",
    name: "Marketing",
    orgUnit: "Marketing",
    parentOrgUnit: "Go-to-Market",
    share: 8,
    lead: "Director of Marketing",
    titles: [
      "Product Marketing Manager",
      "Content Marketing Manager",
      "Demand Generation Manager",
      "Marketing Designer",
    ],
    teams: ["Marketing"],
  },
  {
    key: "finance",
    name: "Finance",
    orgUnit: "Finance",
    parentOrgUnit: "Operations",
    share: 5,
    lead: "Head of Finance",
    titles: ["Senior Accountant", "Financial Analyst", "Accounts Payable Specialist"],
    teams: ["Finance"],
  },
  {
    key: "people",
    name: "People",
    orgUnit: "People",
    parentOrgUnit: "Operations",
    share: 4,
    lead: "Head of People",
    titles: ["People Partner", "Recruiter", "People Operations Coordinator"],
    teams: ["People"],
  },
  {
    key: "legal",
    name: "Legal",
    orgUnit: "Legal",
    parentOrgUnit: "Operations",
    share: 3,
    lead: "General Counsel",
    titles: ["Corporate Counsel", "Legal Operations Specialist"],
    teams: ["Legal"],
  },
  {
    key: "operations",
    name: "Operations",
    orgUnit: "IT & Workplace",
    parentOrgUnit: "Operations",
    share: 4,
    lead: "Director of Operations",
    titles: ["IT Specialist", "Workplace Coordinator", "Business Operations Analyst"],
    teams: ["IT"],
  },
];

/** Parent org units that hold no people directly. */
export const UMBRELLA_ORG_UNITS = ["Go-to-Market", "Operations"] as const;

type PersonStatus = "active" | "suspended" | "offboarded" | "invited";

export interface Person {
  readonly index: number;
  readonly key: string;
  readonly actorId: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly displayName: string;
  /** Sign-in and primary mailbox address. */
  readonly email: string;
  /** Company-domain aliases that also deliver to this mailbox. */
  readonly aliases: readonly string[];
  readonly department: DepartmentKey;
  readonly team: string;
  readonly jobTitle: string;
  readonly managerKey: string | null;
  readonly pronouns: string;
  readonly location: string;
  readonly status: PersonStatus;
  readonly isAdmin: boolean;
  readonly login: "admin" | "user" | null;
  readonly password: string;
  /** Days before "now" when the person joined. */
  readonly tenureDays: number;
}

const FIRST_NAMES = (
  "Amara Bennett Caio Dalia Emeka Freya Gideon Hana Ilse Jonah Kalani Lorenzo Mireille " +
  "Nikhil Odette Pavel Quinn Rosalind Saoirse Tobias Ulla Valentin Wren Ximena Yusuf Zora " +
  "Anouk Bastian Celeste Darius Elodie Farid Greta Hollis Ines Jasper Keiko Leandro Maren " +
  "Nadia Oren Petra Rafael Sunniva Teodor Uma Vikram Wilhelmina Yara Aurelio Bryony Cyrus " +
  "Delphine Ezra Fiorella Gustav Halima Idris Juniper Kaveh Linnea Matteo Nell Osei " +
  "Priyanka Rowan Signe Thabo Viviane Wiremu Aiko Bram Cosima Dmitri Esme Florian Ingrid " +
  "Kofi Lucinda Marisol"
).split(" ");

const FAMILY_NAMES = (
  "Abernathy Balogun Castellanos Delacroix Eriksen Fairweather Galloway Haddadi Ibarra " +
  "Janssen Kowalczyk Lindqvist Mbeki Navarro Okonkwo Pellegrini Quintero Rasmussen Szabo " +
  "Takahashi Underhill Valdivia Whitlock Yamamoto Zielinski Achterberg Bramwell Cardoso " +
  "Dunmore Esposito Featherstone Grünewald Holloway Iwasaki Jovanovic Kerrigan Laurent " +
  "Moreau Nakagawa Oyelaran Pemberton Ramírez Sorensen Thorne Ueda Vasquez Winslow Xu " +
  "Yilmaz Zamora Ashdown Beaumont Chakraborty Draper Ekwueme Fontaine Gallagher Hargreave " +
  "Ishikawa Kristiansen Lachance Mahlangu Nieminen Ostrowski Prescott Rourke Sandoval " +
  "Tamura Varga Wetherby"
).split(" ");

const LOCATIONS = [
  ["Providence office", 6],
  ["Remote — Toronto", 2],
  ["Remote — Denver", 2],
  ["Remote — Lisbon", 1],
  ["Remote — Austin", 2],
  ["Brooklyn office", 4],
] as const;

const PRONOUNS = [
  ["she/her", 10],
  ["he/him", 10],
  ["they/them", 2],
  ["", 6],
] as const;

interface FixedPerson {
  readonly givenName: string;
  readonly familyName: string;
  readonly department: DepartmentKey;
  readonly jobTitle: string;
  readonly login: "admin" | "user";
  readonly actorId: string;
  readonly email: string;
  readonly password: string;
}

/** The two documented sign-in accounts, with the IDs smoke tests already use. */
export const LOGIN_ACCOUNTS: readonly FixedPerson[] = [
  {
    givenName: "Avery",
    familyName: "Park",
    department: "operations",
    jobTitle: "IT & Workspace Administrator",
    login: "admin",
    actorId: "00000000-0000-4000-8000-000000000110",
    email: "admin@helix.local",
    password: "helix-admin-password",
  },
  {
    givenName: "Riley",
    familyName: "Chen",
    department: "product",
    jobTitle: "Senior Product Manager",
    login: "user",
    actorId: "00000000-0000-4000-8000-000000000111",
    email: "user@helix.local",
    password: "helix-user-password",
  },
];

function slugName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/gu, "");
}

/**
 * The roster for `headcount` people. The first people are the department
 * leads, so a smaller preset is a strict prefix of a larger one.
 */
export function buildRoster(headcount: number): readonly Person[] {
  const random = SeedRandom.stream("roster");
  const given = random.shuffle(FIRST_NAMES);
  // Pair names so no two people share a full name, even in the largest preset.
  const names = Array.from({ length: given.length * 2 }, (_, index) => [
    given[index % given.length] ?? "",
    FAMILY_NAMES[(index * 7 + Math.floor(index / given.length) * 13) % FAMILY_NAMES.length] ?? "",
  ]);
  const slots = departmentSlots(headcount);
  const people: Person[] = [];
  const leadByDepartment = new Map<DepartmentKey, string>();
  const ceoKey = "person-0";
  let nameIndex = 0;
  for (const [index, slot] of slots.entries()) {
    const fixed = LOGIN_ACCOUNTS.find((account) => account.login === slot.login);
    const [givenName, familyName] =
      fixed === undefined
        ? (names[nameIndex++ % names.length] as [string, string])
        : [fixed.givenName, fixed.familyName];
    const key = `person-${String(index)}`;
    const department = DEPARTMENTS.find((entry) => entry.key === slot.department) as Department;
    const isLead = slot.lead;
    if (isLead) leadByDepartment.set(slot.department, key);
    const localPart = `${slugName(givenName)}.${slugName(familyName)}`;
    const companyAddress = `${localPart}@${COMPANY.domain}`;
    const location = random.weighted(LOCATIONS.map(([name, weight]) => [name, weight] as const));
    const managerKey =
      key === ceoKey ? null : isLead ? ceoKey : (leadByDepartment.get(slot.department) ?? ceoKey);
    people.push({
      index,
      key,
      actorId: fixed?.actorId ?? seedUuid("actor", key),
      givenName,
      familyName,
      displayName: `${givenName} ${familyName}`,
      email: fixed?.email ?? companyAddress,
      aliases: fixed === undefined ? [] : [companyAddress],
      department: slot.department,
      team: department.teams[index % department.teams.length] ?? department.name,
      jobTitle:
        fixed?.jobTitle ??
        (isLead
          ? department.lead
          : random.pick(department.titles.length > 0 ? department.titles : [department.lead])),
      managerKey,
      pronouns: random.weighted(PRONOUNS.map(([value, weight]) => [value, weight] as const)),
      location,
      status: fixed === undefined ? slot.status : "active",
      isAdmin: fixed?.login === "admin" || slot.department === "operations",
      login: fixed?.login ?? null,
      password: fixed?.password ?? DEMO_PASSWORD,
      tenureDays: isLead || fixed !== undefined ? random.int(760, 980) : random.int(40, 960),
    });
  }
  return people;
}

interface Slot {
  readonly department: DepartmentKey;
  readonly lead: boolean;
  readonly login: "admin" | "user" | null;
  readonly status: PersonStatus;
}

function departmentSlots(headcount: number): readonly Slot[] {
  if (headcount < 30) throw new Error("The demo company needs at least 30 people.");
  const slots: Slot[] = [
    { department: "leadership", lead: true, login: null, status: "active" },
    { department: "leadership", lead: false, login: null, status: "active" },
  ];
  for (const department of DEPARTMENTS) {
    if (department.key !== "leadership") {
      slots.push({ department: department.key, lead: true, login: null, status: "active" });
    }
  }
  slots.push({ department: "operations", lead: false, login: "admin", status: "active" });
  slots.push({ department: "product", lead: false, login: "user", status: "active" });
  const weighted = DEPARTMENTS.filter((department) => department.share > 0).map(
    (department) => [department.key, department.share] as const,
  );
  const random = SeedRandom.stream("slots");
  while (slots.length < headcount) {
    const position = slots.length;
    // Roughly 1 in 25 people is suspended, 1 in 20 offboarded and 1 in 30 still invited.
    const status: PersonStatus =
      position % 25 === 7
        ? "suspended"
        : position % 20 === 11
          ? "offboarded"
          : position % 30 === 17
            ? "invited"
            : "active";
    slots.push({ department: random.weighted(weighted), lead: false, login: null, status });
  }
  return slots;
}

export function personByKey(roster: readonly Person[], key: string): Person {
  const person = roster.find((entry) => entry.key === key);
  if (person === undefined) throw new Error(`Unknown demo person ${key}.`);
  return person;
}

/** People who still work here and use the workspace. */
export function activePeople(roster: readonly Person[]): readonly Person[] {
  return roster.filter((person) => person.status === "active");
}

export function loginPerson(roster: readonly Person[], login: "admin" | "user"): Person {
  const person = roster.find((entry) => entry.login === login);
  if (person === undefined) throw new Error(`The ${login} login is missing from the roster.`);
  return person;
}

/** The address teammates use when writing to someone. */
export function companyAddress(person: Person): string {
  return person.aliases[0] ?? person.email;
}
