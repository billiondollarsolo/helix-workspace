/**
 * The fictional world around Quillfeather Labs: customers, vendors, mailing
 * lists and the vocabulary its people write in. All names are invented and
 * every domain is under the reserved `.example` TLD.
 */

export interface ExternalOrg {
  readonly key: string;
  readonly name: string;
  readonly domain: string;
  readonly people: readonly (readonly [given: string, family: string, title: string])[];
  /** Sending IP inside TEST-NET-2 (RFC 5737). */
  readonly ip: string;
}

export const CUSTOMERS: readonly ExternalOrg[] = [
  org("harborline", "Harborline Freight", "harborline-freight.example", 1, [
    ["Callum", "Brightwater", "Director of Dispatch"],
    ["Nia", "Okafor", "Fleet Operations Manager"],
  ]),
  org("meridian", "Meridian Grocers", "meridian-grocers.example", 2, [
    ["Petronella", "Vance", "VP Supply Chain"],
    ["Hugo", "Ferreira", "Logistics Analyst"],
  ]),
  org("cobalt", "Cobalt Ridge Logistics", "cobaltridge.example", 3, [
    ["Ottilie", "Marsh", "Chief Operating Officer"],
    ["Ravi", "Santhanam", "IT Manager"],
  ]),
  org("pinewater", "Pinewater Dairy Co-op", "pinewater-dairy.example", 4, [
    ["Agnes", "Holloway-Reid", "Distribution Lead"],
  ]),
  org("ashgrove", "Ashgrove Couriers", "ashgrove-couriers.example", 5, [
    ["Mateus", "Lindgren", "Founder"],
    ["Bea", "Achebe", "Operations Coordinator"],
  ]),
  org("northgate", "Northgate Medical Supply", "northgate-medical.example", 6, [
    ["Ingrid", "Solberg", "Procurement Manager"],
    ["Felix", "Adeyemi", "Compliance Officer"],
  ]),
  org("tidewater", "Tidewater Produce", "tidewater-produce.example", 7, [
    ["Lorne", "MacAllister", "Route Planning Manager"],
  ]),
  org("brightmoor", "Brightmoor Bakeries", "brightmoor-bakeries.example", 8, [
    ["Clementine", "Duval", "Head of Operations"],
  ]),
  org("copperleaf", "Copperleaf Pharmacy Group", "copperleaf-rx.example", 9, [
    ["Samir", "Haddad", "Director of Fulfilment"],
    ["Ellery", "Quist", "Systems Integrator"],
  ]),
  org("silverline", "Silverline Movers", "silverline-movers.example", 10, [
    ["Rosa", "Mendel", "General Manager"],
  ]),
];

export const VENDORS: readonly ExternalOrg[] = [
  org("ledgerly", "Ledgerly", "ledgerly.example", 20, [["Billing", "Team", "Accounts receivable"]]),
  org("cloudcabin", "Cloudcabin Hosting", "cloudcabin.example", 21, [
    ["Account", "Desk", "Billing"],
  ]),
  org("parcelpost", "Parcelpost", "parcelpost.example", 22, [
    ["Shipping", "Updates", "Notifications"],
  ]),
  org("printhouse", "Printhouse Supply", "printhouse-supply.example", 23, [
    ["Orders", "Desk", "Customer care"],
  ]),
  org("officecrate", "Officecrate", "officecrate.example", 24, [
    ["Marta", "Kowalski", "Account manager"],
  ]),
  org("skylark", "Skylark Air", "skylark-air.example", 25, [["Reservations", "", "Bookings"]]),
  org("staybright", "Staybright Hotels", "staybright.example", 26, [
    ["Guest", "Services", "Reservations"],
  ]),
  org("quickcab", "Quickcab", "quickcab.example", 27, [["Receipts", "", "Trips"]]),
  org("tessera", "Tessera Insurance", "tessera-insurance.example", 28, [
    ["Dorian", "Ash", "Broker"],
  ]),
  org("bluegate", "Bluegate Payroll", "bluegate-payroll.example", 29, [
    ["Payroll", "Support", "Payroll operations"],
  ]),
  org("brewline", "Brewline Coffee Service", "brewline.example", 30, [
    ["Orders", "", "Office delivery"],
  ]),
];

export const NEWSLETTERS: readonly ExternalOrg[] = [
  org("fleetops", "Fleet Ops Weekly", "fleetops-weekly.example", 40, [
    ["Editors", "", "Newsletter"],
  ]),
  org("routing", "The Routing Report", "routingreport.example", 41, [["Digest", "", "Newsletter"]]),
  org("saasfin", "SaaS Finance Digest", "saasfinance.example", 42, [["Newsletter", "", "Editors"]]),
  org("designsys", "Design Systems Monthly", "designsystems-monthly.example", 43, [
    ["Issue", "", "Editors"],
  ]),
  org("supportlead", "Support Leaders Brief", "supportleaders.example", 44, [
    ["Brief", "", "Editors"],
  ]),
];

export const PROMOTERS: readonly ExternalOrg[] = [
  org("gearloft", "Gearloft Outfitters", "gearloft.example", 50, [["Deals", "", "Marketing"]]),
  org("paperwhale", "Paperwhale Stationery", "paperwhale.example", 51, [
    ["Hello", "", "Marketing"],
  ]),
  org("northbean", "Northbean Coffee Club", "northbean.example", 52, [["Club", "", "Marketing"]]),
];

/** Unsolicited senders whose mail people report as spam. */
export const SPAMMERS: readonly ExternalOrg[] = [
  org("prizedesk", "Prize Desk", "prize-desk.example", 60, [["Winner", "Notice", "Promotions"]]),
  org("leadsurge", "LeadSurge Data", "leadsurge.example", 61, [["Growth", "Team", "Sales"]]),
];

function org(
  key: string,
  name: string,
  domain: string,
  host: number,
  people: ExternalOrg["people"],
): ExternalOrg {
  return { key, name, domain, people, ip: `198.51.100.${String(host)}` };
}

export function externalAddress(entity: ExternalOrg, index = 0): { address: string; name: string } {
  const [given, family] = entity.people[index % entity.people.length] ?? ["Team", "", ""];
  const local =
    family === ""
      ? given.toLowerCase().replace(/[^a-z]/gu, "")
      : `${given}.${family}`.toLowerCase().replace(/[^a-z.]/gu, "");
  const name = family === "" ? entity.name : `${given} ${family}`;
  return { address: `${local}@${entity.domain}`, name };
}

export const FEATURES = [
  "multi-depot routing",
  "driver shift swaps",
  "live ETA sharing",
  "cold-chain alerts",
  "proof-of-delivery photos",
  "route replay",
  "capacity forecasting",
  "customer delivery windows",
  "offline driver mode",
  "fuel cost reports",
  "dock scheduling",
  "returns pickups",
];

export const SERVICES = [
  "routing-engine",
  "dispatch-api",
  "driver-app-sync",
  "eta-service",
  "billing-worker",
  "notifications",
  "geocoder",
  "reporting-warehouse",
];

export const CAMPAIGNS = [
  "Spring fleet efficiency webinar",
  "Waypoint 5 launch",
  "Cold-chain playbook",
  "Regional grocers roadshow",
  "Customer story: Harborline",
  "Year-end planning guide",
];

export const BOOKS = [
  "The Lighthouse Ledger",
  "Small Engines of Change",
  "A Map of Quiet Roads",
  "The Cartographer's Apprentice",
  "Notes from the Night Shift",
  "Tides and Timetables",
];

export const LUNCH_SPOTS = [
  "the taqueria on Wickenden",
  "the noodle bar",
  "the falafel truck",
  "the new ramen place",
  "the deli across the street",
];

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function monthName(date: Date): string {
  return MONTHS[date.getUTCMonth()] ?? "January";
}

export function quarterLabel(date: Date): string {
  return `Q${String(Math.floor(date.getUTCMonth() / 3) + 1)} ${String(date.getUTCFullYear())}`;
}
