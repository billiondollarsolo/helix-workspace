/**
 * Seed ~10 spreadsheets with 2-4 tabs each and ~50-100 cells per sheet.
 *
 * Sheets:   g000 group
 * Tabs:     g100 group
 * Cells:    g200 group (modular idx)
 */

import {
  ADMIN_ACTOR,
  FOLDER,
  WORKSPACE_SEED_LARGE_SOURCE,
  grantBoth,
  json,
  uid,
  type SeedSql,
} from "./config.js";

interface TabDef {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

interface SheetDef {
  readonly idx: number;
  readonly title: string;
  readonly folderId: string;
  readonly tabs: readonly TabDef[];
}

const SHEETS: readonly SheetDef[] = [
  {
    idx: 1,
    title: "Q3 OKR Tracker",
    folderId: FOLDER.roadmap,
    tabs: [
      {
        name: "Engineering",
        rows: [
          ["OKR", "Owner", "Target", "Status", "Score"],
          ["Assistant chaining GA", "Alex Torres", "Aug 15", "In progress", "0.6"],
          ["Meet recording pipeline", "Ben Hayes", "Sep 10", "In progress", "0.4"],
          ["WebSocket pooling", "Alex Torres", "Jul 15", "In review", "0.8"],
          ["SOC 2 prep", "Gabriel Luna", "Sep 30", "In progress", "0.3"],
          ["Mobile offline reads", "Kai Nakamura", "Jun 4", "In progress", "0.7"],
        ],
      },
      {
        name: "Product",
        rows: [
          ["OKR", "Owner", "Target", "Status", "Score"],
          ["Drive browser redesign", "Sam Walker", "Jul 20", "In design", "0.5"],
          ["Share dialog rewording", "Sam Walker", "Jul 5", "Done", "1.0"],
          ["Keyboard shortcut MVP", "Celia Wright", "Aug 1", "Not started", "0.0"],
          ["Onboarding flow v2", "Diana Singh", "Jul 31", "In progress", "0.4"],
        ],
      },
      {
        name: "Summary",
        rows: [
          ["Team", "Q3 OKRs", "On track", "At risk", "Done"],
          ["Engineering", "5", "3", "1", "1"],
          ["Product", "4", "2", "1", "1"],
          ["Design", "3", "2", "0", "1"],
          ["Total", "12", "7", "2", "3"],
        ],
      },
    ],
  },
  {
    idx: 2,
    title: "Hiring Pipeline — Q2/Q3",
    folderId: FOLDER.hiring,
    tabs: [
      {
        name: "Open Roles",
        rows: [
          ["Role", "Team", "Level", "Req date", "Status", "Recruiter"],
          ["Backend Engineer", "Platform", "Senior", "2026-04-01", "Active", "Vera Stone"],
          ["Frontend Engineer", "Web", "Mid", "2026-04-15", "Active", "Vera Stone"],
          ["SRE", "Infra", "Senior", "2026-05-01", "Active", "Vera Stone"],
          ["Product Manager", "Product", "Senior", "2026-03-15", "On hold", "Vera Stone"],
          ["UX Researcher", "Design", "Mid", "2026-05-10", "Active", "Vera Stone"],
        ],
      },
      {
        name: "Pipeline",
        rows: [
          ["Candidate", "Role", "Stage", "Last action", "Decision"],
          ["Jordan Mwangi", "Backend Engineer", "Onsite", "May 18", "Pending debrief"],
          ["Preet Arora", "Backend Engineer", "Offer", "May 20", "Accepted"],
          ["Sophie Lindqvist", "Frontend Engineer", "Technical round", "May 19", "Pending"],
          ["Dev Sharma", "SRE", "Screen", "May 21", "Pending"],
          ["Mia Larsson", "UX Researcher", "Phone screen", "May 20", "Pending"],
          ["Sam Osei", "Backend Engineer", "Rejected", "May 15", "No hire"],
          ["Ana Becker", "Frontend Engineer", "Offer", "May 18", "Countered"],
        ],
      },
      {
        name: "Metrics",
        rows: [
          ["Metric", "Q1 actual", "Q2 actual", "Q3 target"],
          ["Applications", "220", "310", "400"],
          ["Phone screens", "44", "62", "80"],
          ["Onsites", "18", "24", "30"],
          ["Offers", "8", "12", "15"],
          ["Hires", "6", "9", "12"],
          ["Offer acceptance rate", "75%", "75%", "80%"],
          ["Time to offer (days)", "38", "32", "28"],
        ],
      },
    ],
  },
  {
    idx: 3,
    title: "Expense Tracker 2026",
    folderId: FOLDER.finance,
    tabs: [
      {
        name: "May",
        rows: [
          ["Date", "Team", "Category", "Description", "Amount", "Submitted by", "Status"],
          ["2026-05-02", "Engineering", "Software", "GitHub Copilot seats (14)", "168.00", "Will Cross", "Approved"],
          ["2026-05-03", "Sales", "Travel", "Flight to Northwind HQ", "412.00", "Marco Vitale", "Approved"],
          ["2026-05-05", "Marketing", "Events", "DevConf early-bird tickets (4)", "1200.00", "Tara Chan", "Approved"],
          ["2026-05-08", "Team", "Meals", "Team lunch", "184.20", "Fiona Marsh", "Approved"],
          ["2026-05-12", "Design", "Software", "Figma seat renewal", "29.00", "Sam Walker", "Approved"],
          ["2026-05-14", "Engineering", "Travel", "Conference flight — Ivan", "388.00", "Ivan Petrov", "Approved"],
          ["2026-05-15", "Engineering", "Office", "Keyboard and mouse", "120.00", "Ben Hayes", "Approved"],
          ["2026-05-19", "Product", "Office", "Standing desk riser", "78.99", "Diana Singh", "Approved"],
          ["2026-05-20", "Legal", "Services", "Outside counsel — DPA review", "1800.00", "Lena Fischer", "Approved"],
        ],
      },
      {
        name: "April",
        rows: [
          ["Date", "Team", "Category", "Description", "Amount", "Submitted by", "Status"],
          ["2026-04-03", "Sales", "Meals", "Client dinner — Northwind", "146.75", "Marco Vitale", "Approved"],
          ["2026-04-07", "Engineering", "Software", "Datadog monitoring add-on", "59.00", "Ivan Petrov", "Approved"],
          ["2026-04-11", "Engineering", "Travel", "Train tickets — Berlin meetup", "88.40", "Alex Torres", "Approved"],
          ["2026-04-15", "People", "Events", "Q1 team offsite deposits", "2400.00", "Vera Stone", "Approved"],
          ["2026-04-22", "Design", "Software", "Font license renewal", "240.00", "Sam Walker", "Approved"],
          ["2026-04-28", "Marketing", "Content", "Video production — demo", "3200.00", "Jade Osei", "Approved"],
        ],
      },
      {
        name: "Summary",
        rows: [
          ["Month", "Total", "Budget", "Variance", "Notes"],
          ["January", "4200.00", "8000.00", "-3800.00", "Under budget"],
          ["February", "5100.00", "8000.00", "-2900.00", ""],
          ["March", "7800.00", "8000.00", "-200.00", "Q1 offsite planning"],
          ["April", "6134.15", "8000.00", "-1865.85", ""],
          ["May", "4380.19", "8000.00", "-3619.81", "Month not closed"],
        ],
      },
    ],
  },
  {
    idx: 4,
    title: "Budget Forecast FY2026",
    folderId: FOLDER.finance,
    tabs: [
      {
        name: "Headcount",
        rows: [
          ["Department", "H1 Actual", "H2 Forecast", "Year-end HC", "Open reqs"],
          ["Engineering", "14", "18", "18", "4"],
          ["Product", "5", "6", "6", "1"],
          ["Design", "4", "5", "5", "1"],
          ["Customer Success", "3", "4", "4", "1"],
          ["Sales & BD", "3", "5", "5", "2"],
          ["Finance & Ops", "2", "2", "2", "0"],
          ["Legal", "1", "1", "1", "0"],
          ["People", "2", "2", "2", "0"],
          ["Total", "34", "43", "43", "9"],
        ],
      },
      {
        name: "Operating Expenses",
        rows: [
          ["Line item", "Q1 actual", "Q2 actual", "Q3 forecast", "Q4 forecast"],
          ["Payroll & benefits", "1240000", "1350000", "1520000", "1600000"],
          ["Infrastructure & cloud", "64000", "72000", "88000", "96000"],
          ["Software & tools", "38000", "41000", "44000", "46000"],
          ["Travel & expenses", "22000", "26000", "32000", "36000"],
          ["Marketing", "96000", "148000", "210000", "240000"],
          ["Professional services", "44000", "52000", "60000", "64000"],
          ["Office & facilities", "18000", "18000", "18000", "18000"],
          ["Total OpEx", "1522000", "1707000", "1972000", "2100000"],
        ],
      },
      {
        name: "Revenue",
        rows: [
          ["Line item", "Q1 actual", "Q2 actual", "Q3 forecast", "Q4 forecast"],
          ["Team plan subscriptions", "320000", "385000", "460000", "540000"],
          ["Enterprise contracts", "120000", "180000", "320000", "480000"],
          ["Professional services", "24000", "32000", "40000", "48000"],
          ["Total Revenue", "464000", "597000", "820000", "1068000"],
        ],
      },
    ],
  },
  {
    idx: 5,
    title: "Customer Account Health",
    folderId: FOLDER.research,
    tabs: [
      {
        name: "Enterprise",
        rows: [
          ["Account", "Seats", "MRR", "DAU rate", "Health", "Renewal date", "CSM"],
          ["Northwind", "85", "18700", "82%", "Green", "2026-06-30", "Nina Patel"],
          ["Acme Corp", "42", "9240", "71%", "Yellow", "2026-09-30", "Marco Vitale"],
          ["Riviera Hotels", "28", "6160", "65%", "Yellow", "2026-07-31", "Nina Patel"],
          ["Beacon Analytics", "20", "4400", "90%", "Green", "2026-11-30", "Marco Vitale"],
          ["Orion Health", "60", "13200", "78%", "Green", "2026-08-31", "Nina Patel"],
          ["Summit Capital", "15", "3300", "55%", "Red", "2026-10-31", "Marco Vitale"],
          ["Harbor Tech", "25", "5500", "80%", "Green", "2026-12-31", "Nina Patel"],
        ],
      },
      {
        name: "Metrics",
        rows: [
          ["Metric", "Q1", "Q2", "Target"],
          ["NPS (enterprise)", "42", "48", "50"],
          ["Churn rate", "2.1%", "1.8%", "<2%"],
          ["Expansion MRR", "18%", "22%", "25%"],
          ["Support tickets/org/month", "4.2", "3.8", "<4"],
          ["Time to first value (days)", "12", "9", "<10"],
        ],
      },
    ],
  },
  {
    idx: 6,
    title: "Product Analytics — May 2026",
    folderId: FOLDER.data,
    tabs: [
      {
        name: "DAU by Surface",
        rows: [
          ["Surface", "Week 1", "Week 2", "Week 3", "Week 4", "MoM change"],
          ["Mail", "1780", "1802", "1825", "1840", "+12%"],
          ["Docs", "1240", "1280", "1320", "1340", "+15%"],
          ["Calendar", "1210", "1240", "1265", "1290", "+10%"],
          ["Chat", "1120", "1145", "1170", "1190", "+8%"],
          ["Drive", "980", "1000", "1030", "1050", "+13%"],
          ["Sheets", "480", "530", "580", "610", "+42%"],
          ["Meet", "500", "510", "515", "520", "+6%"],
          ["Slides", "300", "320", "330", "340", "+18%"],
        ],
      },
      {
        name: "Assistant",
        rows: [
          ["Action type", "Week 1", "Week 2", "Week 3", "Week 4"],
          ["Summarize thread", "1240", "1380", "1520", "1680"],
          ["Draft reply", "820", "960", "1100", "1240"],
          ["Create event", "340", "390", "440", "490"],
          ["Find file", "280", "310", "340", "380"],
          ["Chain: draft + attach", "180", "240", "310", "390"],
          ["Chain: draft + schedule", "120", "160", "200", "250"],
        ],
      },
      {
        name: "Retention",
        rows: [
          ["Cohort week", "Week 1", "Week 2", "Week 4", "Week 8"],
          ["2026-W10", "100%", "72%", "68%", "62%"],
          ["2026-W11", "100%", "74%", "70%", "64%"],
          ["2026-W12", "100%", "73%", "69%", "—"],
          ["2026-W13", "100%", "75%", "—", "—"],
          ["2026-W14", "100%", "—", "—", "—"],
        ],
      },
    ],
  },
  {
    idx: 7,
    title: "Infrastructure Cost Analysis",
    folderId: FOLDER.infra,
    tabs: [
      {
        name: "Monthly Costs",
        rows: [
          ["Service", "Jan", "Feb", "Mar", "Apr", "May", "Trend"],
          ["Compute (EC2/ECS)", "24000", "24800", "25600", "26400", "27200", "Up 3%/mo"],
          ["Database (RDS)", "8400", "8400", "9200", "9200", "9200", "Stable"],
          ["Object storage (S3)", "3200", "3400", "3600", "4000", "4400", "Up 8%/mo"],
          ["CDN (CloudFront)", "1200", "1300", "1400", "1500", "1600", "Up 7%/mo"],
          ["Cache (ElastiCache)", "2400", "2400", "2400", "2400", "2400", "Stable"],
          ["Monitoring (Datadog)", "1800", "1800", "2000", "2000", "2000", "Stable"],
          ["Total", "41000", "42100", "44200", "45500", "46800", "Up 3%/mo"],
        ],
      },
      {
        name: "Forecast",
        rows: [
          ["Scenario", "Q3 forecast", "Q4 forecast", "Notes"],
          ["Base", "52000/mo", "58000/mo", "Organic growth"],
          ["Enterprise tier (current storage)", "56000/mo", "62000/mo", "Dedicated buckets"],
          ["Enterprise tier (new storage)", "60000/mo", "66000/mo", "New tier pricing"],
        ],
      },
    ],
  },
  {
    idx: 8,
    title: "Content Calendar — Q3",
    folderId: FOLDER.content,
    tabs: [
      {
        name: "June",
        rows: [
          ["Date", "Title", "Format", "Author", "Status"],
          ["Jun 2", "Northwind case study", "Case study", "Quinn Reed", "In review"],
          ["Jun 5", "5 assistant workflows", "Blog", "Jade Osei", "In progress"],
          ["Jun 9", "What's new — May 2026", "Product update", "Diana Singh", "Scheduled"],
          ["Jun 12", "Sheets formula engine deep dive", "Technical blog", "Evan Brooks", "Draft"],
          ["Jun 16", "Designing the Drive browser", "Design blog", "Sam Walker", "Not started"],
          ["Jun 19", "Inbox to agenda in 2 clicks", "Tip & trick", "Quinn Reed", "Not started"],
          ["Jun 23", "Orion Health compliance case study", "Case study", "Quinn Reed", "Not started"],
          ["Jun 30", "Q3 sneak peek", "Blog", "Diana Singh", "Not started"],
        ],
      },
      {
        name: "July",
        rows: [
          ["Date", "Title", "Format", "Author", "Status"],
          ["Jul 7", "Enterprise launch announcement", "Blog", "Diana Singh", "Planned"],
          ["Jul 10", "How to set up your workspace", "How-to", "Quinn Reed", "Planned"],
          ["Jul 14", "Meet recording: walkthrough", "Video", "Jade Osei", "Planned"],
          ["Jul 21", "DevConf 2026: our talks", "Blog", "Tara Chan", "Planned"],
          ["Jul 28", "What's new — June 2026", "Product update", "Diana Singh", "Planned"],
        ],
      },
    ],
  },
  {
    idx: 9,
    title: "Vendor Renewal Tracker",
    folderId: FOLDER.contracts,
    tabs: [
      {
        name: "Renewals",
        rows: [
          ["Vendor", "Contract value", "Renewal date", "Owner", "Status", "Action"],
          ["UserTesting", "12000/yr", "Jul 1, 2026", "Fiona Marsh", "In progress", "Evaluate downgrade"],
          ["CloudSupplier", "180000/yr", "Aug 1, 2026", "Omar Hassan", "In progress", "Negotiate storage pricing"],
          ["Lever ATS", "8400/yr", "Sep 1, 2026", "Vera Stone", "Pending", "Evaluate alternatives"],
          ["GitHub", "4800/yr", "Dec 1, 2026", "Will Cross", "Not started", "—"],
          ["Figma", "6000/yr", "Jan 1, 2027", "Sam Walker", "Not started", "—"],
        ],
      },
      {
        name: "History",
        rows: [
          ["Vendor", "Renewal date", "Old price", "New price", "Change", "Notes"],
          ["Datadog", "Mar 1, 2026", "20000/yr", "24000/yr", "+20%", "Added APM module"],
          ["PagerDuty", "Feb 1, 2026", "3000/yr", "3600/yr", "+20%", "Tier upgrade"],
          ["Postmark", "Feb 1, 2026", "960/yr", "1200/yr", "+25%", "Volume growth"],
        ],
      },
    ],
  },
  {
    idx: 10,
    title: "Sprint Tracker — Sprint 24",
    folderId: FOLDER.engineering,
    tabs: [
      {
        name: "Backlog",
        rows: [
          ["Ticket", "Title", "Team", "Points", "Assignee", "Status"],
          ["HEL-482", "Fix mail importer pagination", "Backend", "3", "Ben Hayes", "Done"],
          ["HEL-480", "WebSocket connection pooling", "Backend", "8", "Alex Torres", "In review"],
          ["HEL-478", "Drive inline folder expansion", "Frontend", "5", "Celia Wright", "Done"],
          ["HEL-476", "Calendar free/busy view", "Frontend", "5", "Celia Wright", "Done"],
          ["HEL-485", "Formula engine perf optimization", "Backend", "5", "Evan Brooks", "In review"],
          ["HEL-481", "Chat message thread replies", "Frontend", "8", "Kai Nakamura", "In review"],
          ["HEL-488", "Meet recording cloud upload", "Backend", "8", "Ben Hayes", "In progress"],
          ["HEL-487", "Search latency improvements", "Backend", "5", "Ivan Petrov", "In progress"],
          ["HEL-490", "Mobile offline read cache", "Mobile", "8", "Kai Nakamura", "In progress"],
          ["HEL-491", "SOC 2 access control evidence", "Security", "3", "Gabriel Luna", "Not started"],
        ],
      },
      {
        name: "Velocity",
        rows: [
          ["Sprint", "Points committed", "Points done", "Carried over", "Notes"],
          ["Sprint 20", "34", "34", "0", "Full delivery"],
          ["Sprint 21", "38", "32", "6", "Incident disruption"],
          ["Sprint 22", "36", "38", "0", "Ahead of plan"],
          ["Sprint 23", "40", "36", "4", "Northwind escalation"],
          ["Sprint 24 (current)", "42", "18", "—", "Mid-sprint"],
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedSheets(sql: SeedSql, orgId: string): Promise<{ sheets: number; tabs: number; cells: number }> {
  let tabCount  = 0;
  let cellCount = 0;

  for (const sheet of SHEETS) {
    const sheetId = uid("f200", sheet.idx);
    await sql`
      insert into sheets (id, org_id, owner_actor_id, created_by_actor_id, title, metadata)
      values (${sheetId}, ${orgId}, ${ADMIN_ACTOR}, ${ADMIN_ACTOR}, ${sheet.title},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict (id) do update set title = excluded.title, metadata = excluded.metadata, updated_at = now()
    `;
    // Shared-PK objects row.
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${sheetId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`sheets/${orgId}/${sheetId}`},
        'application/vnd.helix.spreadsheet', 0, null,
        ${json(sql, {
          source: WORKSPACE_SEED_LARGE_SOURCE,
          app: "sheets",
          name: sheet.title,
          title: sheet.title,
          folderId: sheet.folderId,
        })}
      )
      on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
    `;

    for (const [ti, tab] of sheet.tabs.entries()) {
      const tabId = uid("f300", sheet.idx * 10 + ti);
      await sql`
        insert into sheet_tabs (id, org_id, sheet_id, name, position, metadata)
        values (${tabId}, ${orgId}, ${sheetId}, ${tab.name}, ${ti},
          ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
        on conflict (id) do update set name = excluded.name, position = excluded.position, metadata = excluded.metadata, updated_at = now()
      `;
      tabCount++;

      for (const [rowIdx, row] of tab.rows.entries()) {
        for (const [colIdx, value] of row.entries()) {
          const isHeader = rowIdx === 0;
          // Deterministic but unique cell ID within the g200 group.
          const cellUidIdx = (sheet.idx * 10000 + ti * 1000 + rowIdx * 50 + colIdx) % 99_999_999;
          await sql`
            insert into sheet_cells (id, org_id, sheet_tab_id, row, col, value, format)
            values (
              ${uid("f400", cellUidIdx)},
              ${orgId}, ${tabId}, ${rowIdx}, ${colIdx}, ${value},
              ${json(sql, isHeader ? { bold: true } : {})}
            )
            on conflict (sheet_tab_id, row, col)
            do update set value = excluded.value, format = excluded.format
          `;
          cellCount++;
        }
      }
    }
    await grantBoth(sql, orgId, "sheet", sheetId, "owner");
  }

  return { sheets: SHEETS.length, tabs: tabCount, cells: cellCount };
}
