import { COMPANY, type DepartmentKey, type Person } from "./company.js";
import { barChartPng, csv, encodePng, money, simplePdf } from "./files.js";
import { SeedRandom } from "./random.js";
import { CUSTOMERS, FEATURES, MONTHS, SERVICES, VENDORS, quarterLabel } from "./world.js";

export interface GeneratedFile {
  readonly name: string;
  readonly mimeType: string;
  readonly body: Buffer;
}

const md = (name: string, lines: readonly string[]): GeneratedFile => ({
  name,
  mimeType: "text/markdown",
  body: Buffer.from(`${lines.join("\n")}\n`),
});
const pdf = (name: string, title: string, lines: readonly string[]): GeneratedFile => ({
  name,
  mimeType: "application/pdf",
  body: simplePdf(title, lines),
});
const table = (name: string, rows: readonly (readonly (string | number)[])[]): GeneratedFile => ({
  name,
  mimeType: "text/csv",
  body: csv(rows),
});
const chart = (name: string, values: readonly number[]): GeneratedFile => ({
  name,
  mimeType: "image/png",
  body: barChartPng(values, name),
});

/** Department folders inside each department's shared drive. */
export const DEPARTMENT_FOLDERS: Readonly<Record<DepartmentKey, readonly string[]>> = {
  leadership: ["Board", "Strategy", "Offsites"],
  engineering: ["Architecture", "Runbooks", "Postmortems", "Sprint notes", "Load tests"],
  product: ["Specs", "Research", "Roadmaps", "Release notes"],
  design: ["Design reviews", "Research", "Exports"],
  sales: ["Proposals", "Pipeline", "Pricing", "Call notes"],
  support: ["Playbooks", "Reports", "Escalations"],
  marketing: ["Campaigns", "Events", "Content calendar"],
  finance: ["Invoices", "Budgets", "Expense reports", "Board reporting"],
  people: ["Onboarding", "Recruiting", "Policies"],
  legal: ["Contracts", "Templates", "Compliance"],
  operations: ["IT", "Workplace", "Vendors"],
};

function months(random: SeedRandom, count: number, base: number, spread: number): number[] {
  return Array.from({ length: count }, (_, index) =>
    Math.round(base * (1 + index * 0.06) + random.int(-spread, spread)),
  );
}

/** One department document for `folder`, written as of `when`. */
export function departmentFile(
  department: DepartmentKey,
  folder: string,
  author: Person,
  when: Date,
  random: SeedRandom,
): GeneratedFile {
  const customer = random.pick(CUSTOMERS);
  const feature = random.pick(FEATURES);
  const service = random.pick(SERVICES);
  const quarter = quarterLabel(when);
  const month = MONTHS[when.getUTCMonth()] ?? "January";
  const year = when.getUTCFullYear();
  switch (`${department}/${folder}`) {
    case "engineering/Architecture":
      return md(`RFC-${String(random.int(12, 140))} ${capital(feature)}.md`, [
        `# RFC: ${capital(feature)}`,
        "",
        `Author: ${author.displayName} · Status: ${random.pick(["Draft", "In review", "Accepted"])}`,
        "",
        "## Problem",
        `Dispatchers at ${customer.name} work around the lack of ${feature} with spreadsheets.`,
        "",
        "## Proposal",
        `Add a ${service} endpoint and a background job that recomputes plans every five minutes.`,
        "Keep the existing plan format; add fields instead of renaming them.",
        "",
        "## Risks",
        "- Recompute storms during the morning dispatch peak.",
        "- Mobile clients older than 4.2 ignore unknown fields (acceptable).",
        "",
        "## Rollout",
        "Feature flag per customer, starting with two pilot accounts.",
      ]);
    case "engineering/Runbooks":
      return md(`Runbook - ${service}.md`, [
        `# ${service} runbook`,
        "",
        `Owner: ${author.team} team. Pager: #oncall-${author.team.toLowerCase()}.`,
        "",
        "## Health checks",
        `1. Check the ${service} dashboard for error rate above 2%.`,
        "2. Confirm the queue depth is draining.",
        "3. If the last deploy is under 30 minutes old, roll back first and investigate second.",
        "",
        "## Common alerts",
        "- **High latency**: usually the geocoder cache was cold after a restart.",
        "- **Stuck jobs**: restart one worker at a time; never drain the whole pool.",
      ]);
    case "engineering/Postmortems":
      return md(
        `Postmortem ${String(year)}-${String(when.getUTCMonth() + 1).padStart(2, "0")} ${service}.md`,
        [
          `# Postmortem: ${service} degradation`,
          "",
          `Date: ${when.toISOString().slice(0, 10)} · Severity: ${random.pick(["SEV-2", "SEV-3"])} · Author: ${author.displayName}`,
          "",
          "## Summary",
          `For ${String(random.int(14, 70))} minutes ${customer.name} saw stale ETAs in the driver app.`,
          "",
          "## Timeline",
          "- 07:42 alert fired for elevated latency",
          "- 07:51 on-call acknowledged and paged the routing team",
          "- 08:20 rolled back the cache configuration change",
          "",
          "## What went well / what we will change",
          "Rollback was quick. We will add a canary stage for cache settings.",
        ],
      );
    case "engineering/Load tests":
      return table(`Load test ${quarter}.csv`, [
        ["scenario", "rps", "p50_ms", "p95_ms", "errors"],
        ...["plan-create", "eta-poll", "dispatch-board", "driver-sync"].map((scenario) => [
          scenario,
          random.int(200, 1800),
          random.int(18, 90),
          random.int(120, 480),
          random.int(0, 12),
        ]),
      ]);
    case "product/Specs":
      return md(`PRD - ${capital(feature)}.md`, [
        `# ${capital(feature)}`,
        "",
        `PM: ${author.displayName} · Target: ${quarter}`,
        "",
        "## Why now",
        `Three of our top ten accounts asked for ${feature} in the last quarter, including ${customer.name}.`,
        "",
        "## Goals",
        "- Reduce manual dispatcher edits by a third.",
        "- Ship to all plans without a pricing change.",
        "",
        "## Non-goals",
        "- Changing how routes are billed.",
      ]);
    case "product/Research":
    case "design/Research":
      return md(`Interview - ${customer.name}.md`, [
        `# Customer interview: ${customer.name}`,
        "",
        `Interviewer: ${author.displayName} · ${when.toISOString().slice(0, 10)}`,
        "",
        `> "Most mornings we re-plan at least four routes by hand." — ${customer.people[0]?.[2] ?? "Operations"}`,
        "",
        "## Observations",
        "- Dispatch board is open on a second monitor all day.",
        `- They would pay for ${feature} if it saved one planner hour a day.`,
      ]);
    case "product/Roadmaps":
      return table(`Roadmap ${quarter}.csv`, [
        ["theme", "initiative", "owner", "status"],
        ...FEATURES.slice(0, 6).map((entry, index) => [
          index % 2 === 0 ? "Planning" : "Execution",
          capital(entry),
          author.displayName,
          random.pick(["Discovery", "Building", "Beta", "Shipped"]),
        ]),
      ]);
    case "product/Release notes":
      return md(`Release notes ${String(random.int(4, 5))}.${String(random.int(0, 12))}.md`, [
        `# ${COMPANY.product} release notes`,
        "",
        `## New: ${capital(feature)}`,
        "Available to all customers this week.",
        "",
        "## Fixes",
        "- Exported route sheets now include the depot address.",
        "- Driver app no longer logs out after a phone restart.",
      ]);
    case "design/Design reviews":
      return md(`Design review - ${capital(feature)}.md`, [
        `# Design review: ${capital(feature)}`,
        "",
        `Presenter: ${author.displayName}`,
        "",
        "Feedback:",
        "- The empty state should explain what a depot is.",
        "- Use the existing map legend rather than adding a second one.",
        "- Check contrast of the warning chip in dark mode.",
      ]);
    case "design/Exports":
      return {
        name: `${capital(feature)} mock ${String(random.int(1, 9))}.png`,
        mimeType: "image/png",
        body: mockScreen(random),
      };
    case "sales/Proposals":
      return pdf(
        `Proposal - ${customer.name}.pdf`,
        `${COMPANY.product} proposal for ${customer.name}`,
        [
          `Prepared by ${author.displayName}, ${author.jobTitle}.`,
          "",
          `Scope: ${String(random.int(20, 220))} vehicles across ${String(random.int(2, 9))} depots.`,
          `Annual subscription: ${money(random.int(24, 180) * 1000)}.`,
          "Onboarding: four weeks including two dispatcher workshops.",
          "",
          "This proposal is valid for 30 days.",
        ],
      );
    case "sales/Pipeline":
      return table(`Pipeline ${month} ${String(year)}.csv`, [
        ["account", "stage", "amount_usd", "owner", "close_month"],
        ...CUSTOMERS.slice(0, 7).map((entry) => [
          entry.name,
          random.pick(["Discovery", "Demo", "Proposal", "Negotiation", "Closed won"]),
          random.int(12, 160) * 1000,
          author.displayName,
          MONTHS[(when.getUTCMonth() + random.int(0, 3)) % 12] ?? month,
        ]),
      ]);
    case "sales/Pricing":
      return table(`Price book ${String(year)}.csv`, [
        ["plan", "per_vehicle_month_usd", "minimum_vehicles"],
        ["Starter", 19, 10],
        ["Growth", 29, 25],
        ["Enterprise", 41, 100],
      ]);
    case "sales/Call notes":
      return md(`Call notes - ${customer.name}.md`, [
        `# ${customer.name} — ${when.toISOString().slice(0, 10)}`,
        "",
        `Attendees: ${author.displayName}, ${customer.people[0]?.[0] ?? ""} ${customer.people[0]?.[1] ?? ""}`,
        "",
        `- Interested in ${feature}.`,
        "- Wants a security questionnaire before procurement.",
        "- Next step: send proposal and book a technical deep dive.",
      ]);
    case "support/Playbooks":
      return md(`Playbook - ${capital(feature)} questions.md`, [
        `# Answering questions about ${feature}`,
        "",
        "1. Confirm which plan the customer is on.",
        "2. Link the help center article before writing a long answer.",
        "3. Escalate to the routing team if the plan output looks wrong.",
      ]);
    case "support/Reports":
      return random.chance(0.5)
        ? chart(`Ticket volume ${month}.png`, months(random, 8, 120, 25))
        : table(`CSAT ${month} ${String(year)}.csv`, [
            ["week", "tickets", "csat"],
            ...[1, 2, 3, 4].map((week) => [
              week,
              random.int(80, 190),
              (random.int(88, 98) / 100).toFixed(2),
            ]),
          ]);
    case "support/Escalations":
      return md(`Escalation - ${customer.name}.md`, [
        `# Escalation: ${customer.name}`,
        "",
        `Opened by ${author.displayName}. Priority: ${random.pick(["High", "Normal"])}.`,
        "",
        `Customer reports that ${feature} skipped two stops on Monday. Logs attached in the ticket.`,
      ]);
    case "marketing/Campaigns":
      return md(`Campaign brief - ${capital(feature)}.md`, [
        `# Campaign brief: ${capital(feature)}`,
        "",
        "Audience: operations leaders at regional distributors.",
        "Channels: webinar, two blog posts, partner newsletter.",
        `Goal: ${String(random.int(80, 240))} qualified sign-ups.`,
      ]);
    case "marketing/Events":
      return table(`Webinar registrations ${month}.csv`, [
        ["company", "role", "attended"],
        ...CUSTOMERS.slice(2, 9).map((entry) => [
          entry.name,
          entry.people[0]?.[2] ?? "Operations",
          random.chance(0.6) ? "yes" : "no",
        ]),
      ]);
    case "marketing/Content calendar":
      return table(`Content calendar ${quarter}.csv`, [
        ["week", "piece", "owner", "status"],
        ...[1, 2, 3, 4, 5, 6].map((week) => [
          week,
          `Blog: ${capital(random.pick(FEATURES))}`,
          author.displayName,
          random.pick(["Draft", "Scheduled", "Published"]),
        ]),
      ]);
    case "finance/Invoices": {
      const vendor = random.pick(VENDORS);
      return pdf(
        `Invoice ${vendor.name} ${month} ${String(year)}.pdf`,
        `Invoice from ${vendor.name}`,
        [
          `Invoice number: INV-${String(random.int(10000, 99999))}`,
          `Billed to: ${COMPANY.name}, Accounts Payable`,
          `Period: ${month} ${String(year)}`,
          "",
          `Services: ${vendor.people[0]?.[2] ?? "Subscription"}`,
          `Amount due: ${money(random.int(180, 9200))}`,
          "Terms: net 30",
        ],
      );
    }
    case "finance/Budgets":
      return table(`Budget FY${String(year)}.csv`, [
        ["department", "headcount_cost", "software", "travel", "total"],
        ...["Engineering", "Sales", "Support", "Marketing", "G&A"].map((name) => {
          const people = random.int(300, 2400) * 1000;
          const software = random.int(20, 180) * 1000;
          const travel = random.int(5, 90) * 1000;
          return [name, people, software, travel, people + software + travel];
        }),
      ]);
    case "finance/Expense reports":
      return table(`Expenses ${month} ${String(year)}.csv`, [
        ["date", "employee", "category", "amount_usd"],
        ...Array.from({ length: random.int(6, 14) }, () => [
          `${String(year)}-${String(when.getUTCMonth() + 1).padStart(2, "0")}-${String(random.int(1, 28)).padStart(2, "0")}`,
          author.displayName,
          random.pick(["Travel", "Meals", "Software", "Office"]),
          (random.int(800, 42000) / 100).toFixed(2),
        ]),
      ]);
    case "finance/Board reporting":
      return pdf(`Board update ${quarter}.pdf`, `Board update ${quarter}`, [
        `ARR: ${money(random.int(6, 14) * 1_000_000)} · Net revenue retention ${String(random.int(104, 121))}%`,
        `Customers: ${String(random.int(140, 320))} · Vehicles under management ${String(random.int(9, 30))}k`,
        "",
        "Highlights: two regional grocers signed; churn concentrated in the smallest plan.",
      ]);
    case "people/Onboarding":
      return md("New starter checklist.md", [
        "# First week at Quillfeather",
        "",
        "- [ ] Sign in to the workspace and set a profile photo",
        "- [ ] Join #general and your team space",
        "- [ ] Book a 1:1 with your manager and your onboarding buddy",
        "- [ ] Read the employee handbook in the Company drive",
      ]);
    case "people/Recruiting":
      return table(`Hiring plan ${quarter}.csv`, [
        ["role", "team", "status", "hiring_manager"],
        [
          "Senior Software Engineer",
          "Routing",
          random.pick(["Open", "Offer out"]),
          author.displayName,
        ],
        ["Support Specialist", "Support", random.pick(["Open", "Filled"]), author.displayName],
        ["Account Executive", "Sales", random.pick(["Open", "On hold"]), author.displayName],
      ]);
    case "people/Policies":
      return pdf(
        `${random.pick(["Remote work", "Parental leave", "Learning budget"])} policy.pdf`,
        "People policy",
        [
          "This policy applies to all employees.",
          "Questions go to the People team in #ask-people.",
          `Last reviewed ${month} ${String(year)}.`,
        ],
      );
    case "legal/Contracts":
      return pdf(`MSA - ${customer.name}.pdf`, `Master subscription agreement: ${customer.name}`, [
        `Between ${COMPANY.name} and ${customer.name}.`,
        "Term: 24 months, renewing annually.",
        "Governing law: State of Rhode Island.",
      ]);
    case "legal/Templates":
      return md(
        `${random.pick(["Mutual NDA", "Data processing addendum", "Order form"])} template.md`,
        ["# Template", "", "Use this template only for standard deals. Send redlines to Legal."],
      );
    case "legal/Compliance":
      return table(`Vendor security reviews ${String(year)}.csv`, [
        ["vendor", "data_access", "review_status"],
        ...VENDORS.slice(0, 6).map((vendor) => [
          vendor.name,
          random.pick(["None", "Limited", "Customer data"]),
          random.pick(["Approved", "In review"]),
        ]),
      ]);
    case "operations/IT":
      return table("Laptop inventory.csv", [
        ["asset_tag", "model", "assigned_to", "purchased"],
        ...Array.from({ length: random.int(8, 16) }, (_, index) => [
          `QF-${String(1000 + index)}`,
          random.pick(["14-inch laptop", "16-inch laptop", "13-inch laptop"]),
          random.chance(0.85) ? "assigned" : "spare",
          `${String(year - random.int(0, 2))}-${String(random.int(1, 12)).padStart(2, "0")}`,
        ]),
      ]);
    case "operations/Workplace":
      return md("Office guide - Providence.md", [
        "# Providence office",
        "",
        "Door code changes on the first Monday of each quarter (see #office).",
        'Quiet room bookings go through the calendar resource "Quiet room".',
      ]);
    case "operations/Vendors":
      return table("Vendor contacts.csv", [
        ["vendor", "service", "renewal"],
        ...VENDORS.map((vendor) => [
          vendor.name,
          vendor.people[0]?.[2] ?? "Service",
          MONTHS[random.int(0, 11)] ?? month,
        ]),
      ]);
    default:
      return md(`${folder} notes ${when.toISOString().slice(0, 10)}.md`, [
        `# ${folder}`,
        "",
        `Notes from ${author.displayName}.`,
        `Discussed ${feature} and next steps for ${customer.name}.`,
      ]);
  }
}

/** A personal "My Drive" document: notes, drafts and receipts. */
export function personalFile(author: Person, when: Date, random: SeedRandom): GeneratedFile {
  const kind = random.weighted<string>([
    ["notes", 5],
    ["todo", 3],
    ["receipt", 2],
    ["draft", 3],
    ["photo", 1],
  ]);
  const date = when.toISOString().slice(0, 10);
  switch (kind) {
    case "todo":
      return md(`To do ${date}.md`, [
        "# This week",
        "",
        ...random.sample(
          [
            "- [ ] Review the pull request backlog",
            "- [x] Reply to the customer escalation",
            "- [ ] Book travel for the offsite",
            "- [ ] Update the roadmap doc",
            "- [x] Submit expenses",
            "- [ ] Prepare 1:1 notes",
          ],
          4,
        ),
      ]);
    case "receipt":
      return pdf(`Receipt ${date}.pdf`, `${random.pick(VENDORS).name} receipt`, [
        `Paid by ${author.displayName}`,
        `Total: ${money(random.int(12, 640))}`,
        `Date: ${date}`,
      ]);
    case "draft":
      return md(`Draft - ${capital(random.pick(FEATURES))} idea.md`, [
        "# Rough idea",
        "",
        "Not ready to share yet. Questions to answer before writing it up properly:",
        "- Who asked for this?",
        "- What would we stop doing?",
      ]);
    case "photo":
      return { name: `Whiteboard ${date}.png`, mimeType: "image/png", body: mockScreen(random) };
    default:
      return {
        name: `Notes ${date}.txt`,
        mimeType: "text/plain",
        body: Buffer.from(
          `${author.displayName} — notes\n\n${random
            .sample(
              [
                "Follow up with finance about the renewal.",
                "Ask design for the updated map legend.",
                "Customer wants exports in CSV, not PDF.",
                "Pair with the platform team on the deploy checklist.",
                "Check the on-call rota for next month.",
              ],
              3,
            )
            .join("\n")}\n`,
        ),
      };
  }
}

/** Company-wide documents in the Company shared drive. */
export function companyFiles(
  year: number,
): readonly (GeneratedFile & { readonly folder: string })[] {
  const random = SeedRandom.stream("company-files");
  return [
    {
      folder: "Policies",
      ...pdf("Employee handbook.pdf", `${COMPANY.name} employee handbook`, [
        "Welcome to Quillfeather Labs. This handbook explains how we work together.",
        "Working hours are flexible; core collaboration hours are 11:00-15:00 Eastern.",
        "Paid time off: 25 days plus company holidays. Book time off in your calendar.",
        "Expenses: submit within 30 days with a receipt. See the travel policy for limits.",
      ]),
    },
    {
      folder: "Policies",
      ...pdf("Travel and expense policy.pdf", "Travel and expense policy", [
        "Book flights at least 14 days in advance where possible.",
        "Hotel limit: $240 per night in most cities.",
        "Meals while travelling are covered up to $75 per day.",
      ]),
    },
    {
      folder: "Policies",
      ...md("Information security policy.md", [
        "# Information security policy",
        "",
        "- Use the workspace for company data; do not forward customer data to personal accounts.",
        "- Report suspicious mail with the Report spam button and tell IT in #it-help.",
        "- Two-step verification is required for every account.",
      ]),
    },
    {
      folder: "Benefits",
      ...table(`Company holidays ${String(year)}.csv`, [
        ["date", "holiday"],
        [`${String(year)}-01-01`, "New Year's Day"],
        [`${String(year)}-05-25`, "Memorial Day"],
        [`${String(year)}-07-03`, "Independence Day (observed)"],
        [`${String(year)}-09-07`, "Labor Day"],
        [`${String(year)}-11-26`, "Thanksgiving"],
        [`${String(year)}-12-24`, "Winter break begins"],
      ]),
    },
    {
      folder: "Benefits",
      ...pdf("Benefits overview.pdf", "Benefits overview", [
        "Health, dental and vision coverage starts on your first day.",
        "Learning budget: $1,500 per year.",
        "Home office stipend: $600 when you join.",
      ]),
    },
    {
      folder: "Brand",
      ...md("Brand guidelines.md", [
        "# Brand guidelines",
        "",
        "Primary color: Harbor Blue #2F5D8A. Accent: Signal Orange #E07A2E.",
        'Write in plain language. Say "route", not "optimised path artifact".',
      ]),
    },
    { folder: "Brand", name: "Logo mark.png", mimeType: "image/png", body: mockScreen(random) },
    {
      folder: "All-hands",
      ...table("Headcount by department.csv", [
        ["department", "people"],
        ["Engineering", 31],
        ["Sales", 14],
        ["Support", 10],
        ["Marketing", 8],
        ["Product and Design", 13],
        ["G&A", 14],
      ]),
    },
    { folder: "All-hands", ...chart("ARR growth by quarter.png", months(random, 10, 100, 6)) },
  ];
}

/** A screenshot-like image with soft noise so it does not compress to nothing. */
function mockScreen(random: SeedRandom): Buffer {
  const width = random.int(320, 640);
  const height = Math.round(width * 0.62);
  const seed = random.int(0, 1 << 30);
  return encodePng(width, height, (x, y) => {
    const noise = ((x * 73856093) ^ (y * 19349663) ^ seed) & 15;
    if (y < 28) return [47, 93, 138];
    if (x < 90) return [236 - noise, 240 - noise, 245 - noise];
    if ((y - 40) % 46 < 30 && x > 110 && x < width - 20) return [250 - noise, 250 - noise, 250];
    return [255 - noise, 255 - noise, 255 - noise];
  });
}

/**
 * Bulky exports a data team keeps around: a routing telemetry CSV of roughly
 * `megabytes` MiB and a long PDF report, so storage usage looks lived-in.
 */
export function dataExport(
  month: string,
  megabytes: number,
  random: SeedRandom,
): readonly GeneratedFile[] {
  const regions = ["us-east", "us-central", "us-west", "ca-east", "eu-west"];
  const rows: (string | number)[][] = [
    ["timestamp", "route_id", "region", "stops", "distance_km", "duration_min", "on_time"],
  ];
  const target = megabytes * 1_048_576;
  let size = 0;
  for (let index = 0; size < target; index += 1) {
    const day = String(1 + (index % 28)).padStart(2, "0");
    const hour = String(index % 24).padStart(2, "0");
    const row = [
      `${month}-${day}T${hour}:${String(index % 60).padStart(2, "0")}:00Z`,
      `RT-${String(random.int(100000, 999999))}`,
      regions[index % regions.length] ?? "us-east",
      random.int(3, 42),
      (random.next() * 180 + 4).toFixed(1),
      random.int(18, 420),
      random.chance(0.91) ? "true" : "false",
    ];
    size += row.join(",").length + 1;
    rows.push(row);
  }
  const findings = Array.from({ length: 160 }, (_, index) => {
    const region = regions[index % regions.length] ?? "us-east";
    return `${String(index + 1)}. ${region}: median stop ${String(random.int(3, 11))} min, ${String(random.int(80, 99))}% on time.`;
  });
  return [
    { name: `Routing telemetry ${month}.csv`, mimeType: "text/csv", body: csv(rows) },
    {
      name: `Network performance report ${month}.pdf`,
      mimeType: "application/pdf",
      body: simplePdf(`Network performance ${month}`, findings),
    },
  ];
}

function capital(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
