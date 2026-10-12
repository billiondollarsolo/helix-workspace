import { contactFieldsSchema, type ContactFieldsInput } from "@helix/contracts";
import { activePeople, type Person } from "./company.js";
import { mapLimit } from "./concurrency.js";
import type { Directory } from "./directory.js";
import { SeedRandom, TIME } from "./random.js";
import type { DemoRuntime } from "./runtime.js";
import { CUSTOMERS, VENDORS, externalAddress, type ExternalOrg } from "./world.js";

export interface ContactsSeed {
  readonly contacts: number;
  readonly duplicates: number;
  readonly labels: number;
}

const PERSONAL = [
  ["Marguerite", "Holt", "Dentist's office"],
  ["Theo", "Banerjee", "Neighbour"],
  ["Lupe", "Okoye", "Climbing gym"],
  ["Silas", "Vandermeer", "Accountant"],
  ["Ines", "Calloway", "Daycare"],
  ["Rory", "Feld", "Landlord"],
] as const;

/** A fictional North American number in the reserved 555-01xx range. */
function phone(random: SeedRandom): string {
  return `+1 401 555 01${String(random.int(0, 99)).padStart(2, "0")}`;
}

function externalContact(
  entity: ExternalOrg,
  index: number,
  random: SeedRandom,
  labels: string[],
): ContactFieldsInput {
  const [given, family, title] = entity.people[index % entity.people.length] ?? ["", "", ""];
  return {
    givenName: family === "" ? "" : given,
    familyName: family,
    company: entity.name,
    jobTitle: title,
    emails: [{ type: "work", value: externalAddress(entity, index).address }],
    phones: random.chance(0.7) ? [{ type: "work", value: phone(random) }] : [],
    labels,
    notes: random.chance(0.3) ? "Met at the regional logistics expo." : "",
    starred: random.chance(0.15),
  };
}

/**
 * Personal address books: customers and vendors people work with, a few
 * personal contacts, labels, and the occasional duplicate waiting to be merged.
 */
export async function seedContacts(
  runtime: DemoRuntime,
  directory: Directory,
): Promise<ContactsSeed> {
  const people = activePeople(directory.people);
  let contacts = 0;
  let duplicates = 0;
  let labels = 0;
  await mapLimit(people, 6, async (person: Person) => {
    const random = SeedRandom.stream("contacts", person.key);
    const actor = { orgId: runtime.orgId, actorId: person.actorId };
    const mine = ["Customers", "Vendors", "Personal"];
    if (random.chance(0.4)) mine.push("Conference 2025");
    for (const label of mine) {
      await runtime.contacts.createLabel(actor, label);
      labels += 1;
    }
    const fields: ContactFieldsInput[] = [];
    const customerFacing = ["sales", "support", "product", "leadership"].includes(
      person.department,
    );
    for (const entity of random.sample(
      customerFacing ? CUSTOMERS : VENDORS,
      Math.min(runtime.preset.contactsPerPerson, 8),
    )) {
      fields.push(
        externalContact(entity, random.int(0, 1), random, [
          customerFacing ? "Customers" : "Vendors",
        ]),
      );
    }
    for (const [given, family, note] of random.sample(
      PERSONAL,
      Math.max(1, Math.floor(runtime.preset.contactsPerPerson / 3)),
    )) {
      fields.push({
        givenName: given,
        familyName: family,
        phones: [{ type: "mobile", value: phone(random) }],
        notes: note,
        labels: ["Personal"],
        birthday: random.chance(0.4)
          ? `--${String(random.int(1, 12)).padStart(2, "0")}-${String(random.int(1, 28)).padStart(2, "0")}`
          : null,
      });
    }
    // A duplicate entered twice with a different address, as happens after an import.
    const first = fields[0];
    if (first !== undefined && random.chance(0.35)) {
      fields.push({
        ...first,
        emails: [
          {
            type: "other",
            value: `${(first.givenName ?? "contact").toLowerCase() || "contact"}@personal.example`,
          },
        ],
        labels: [],
      });
      duplicates += 1;
    }
    for (const input of fields) {
      const created = await runtime.contacts.create(actor, contactFieldsSchema.parse(input));
      const at = runtime.timeline.recentWorkday(
        random,
        Math.min(person.tenureDays, runtime.timeline.historyDays),
      );
      runtime.chronology.at(
        "carddav_contacts",
        { id: created.id },
        {
          created_at: at,
          updated_at: runtime.timeline.clamp(new Date(at.getTime() + random.int(0, 60) * TIME.DAY)),
        },
      );
      contacts += 1;
    }
  });
  return { contacts, duplicates, labels };
}
