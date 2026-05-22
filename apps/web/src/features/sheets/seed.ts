/* Sheets seed data — ported from the design handoff
   (`app-sheets-meet-chat.jsx` → SHEETS_LIST + SHEET_DATA).

   There is no backend feature for Sheets, so this typed module is the single
   source of truth for the surface. The grid is intentionally seeded as a 2D
   array of cell strings, mirroring the prototype. */

/** A spreadsheet file as it appears in the list view. */
export interface SheetFile {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly modified: string;
  readonly shared: number;
}

/** Health values that render a colored conditional dot. */
export type SheetHealth = "Green" | "Yellow" | "Red";

/** A single named tab inside a spreadsheet. */
export interface SheetTab {
  readonly id: string;
  readonly name: string;
}

/** A 2D grid of cell strings. Row 0 is the header row. */
export type SheetGrid = ReadonlyArray<ReadonlyArray<string>>;

/** Spreadsheets shown in the list view. */
export const SHEETS_LIST: ReadonlyArray<SheetFile> = [
  {
    id: "sh1",
    title: "Customer Renewals — Q3",
    owner: "Rumi Tanaka",
    modified: "1 hour ago",
    shared: 8,
  },
  { id: "sh2", title: "Q3 Forecast", owner: "Naveen Iyer", modified: "Yesterday", shared: 4 },
  {
    id: "sh3",
    title: "Hiring Pipeline FY26",
    owner: "Sasha Levin",
    modified: "Yesterday",
    shared: 6,
  },
  {
    id: "sh4",
    title: "Engineering OKRs",
    owner: "Jonas Reichert",
    modified: "Monday",
    shared: 12,
  },
  {
    id: "sh5",
    title: "Cloud Spend Breakdown",
    owner: "Daniel Cho",
    modified: "Last week",
    shared: 3,
  },
  {
    id: "sh6",
    title: "Marketing Calendar",
    owner: "Owen Hart",
    modified: "Last week",
    shared: 9,
  },
];

/** Tabs shown at the bottom of the editor. */
export const SHEET_TABS: ReadonlyArray<SheetTab> = [
  { id: "customers", name: "Customers" },
  { id: "pipeline", name: "Pipeline" },
  { id: "lost", name: "Lost" },
  { id: "forecast", name: "Forecast" },
];

/** Per-column pixel widths for the grid. */
export const COL_WIDTHS: ReadonlyArray<number> = [180, 110, 130, 110, 140, 90, 260];

/** Zero-based index of the Health column (drives the conditional dots). */
export const HEALTH_COLUMN = 5;

/** Zero-based index of the ARR column (drives the totals-row aggregation). */
export const ARR_COLUMN = 1;

/** Customers tab — the seeded, editable grid. */
const CUSTOMERS_GRID: SheetGrid = [
  ["Customer", "ARR", "Plan", "Renewal", "Owner", "Health", "Notes"],
  [
    "Atlas Holdings",
    "$420,000",
    "Enterprise",
    "2026-09-30",
    "Rumi Tanaka",
    "Green",
    "Early renewal in flight",
  ],
  [
    "Northwind",
    "$310,000",
    "Enterprise",
    "2026-11-12",
    "Theo Marchetti",
    "Yellow",
    "SCIM provisioning blocked",
  ],
  [
    "Brightline",
    "$184,000",
    "Business Plus",
    "2026-12-04",
    "Rumi Tanaka",
    "Green",
    "Following Northwind cadence",
  ],
  ["Vega Systems", "$96,000", "Business Plus", "2027-02-18", "Rumi Tanaka", "Green", ""],
  [
    "Mercury Labs",
    "$72,000",
    "Business",
    "2026-08-21",
    "Theo Marchetti",
    "Yellow",
    "Pricing concern raised",
  ],
  [
    "Orchid Health",
    "$148,000",
    "Enterprise",
    "2026-07-10",
    "Rumi Tanaka",
    "Red",
    "Exec sponsor left, regroup",
  ],
  [
    "Polaris Bank",
    "$520,000",
    "Enterprise",
    "2027-01-05",
    "Theo Marchetti",
    "Green",
    "MFA upgrade complete",
  ],
  ["Sequoia Foods", "$58,000", "Business", "2026-10-22", "Rumi Tanaka", "Green", ""],
  [
    "Tessera AI",
    "$112,000",
    "Business Plus",
    "2026-09-18",
    "Theo Marchetti",
    "Yellow",
    "Migration paused — Q4",
  ],
  ["Umbra Logistics", "$240,000", "Enterprise", "2027-03-01", "Rumi Tanaka", "Green", ""],
];

/** Pipeline tab — open opportunities. */
const PIPELINE_GRID: SheetGrid = [
  ["Account", "ARR", "Plan", "Renewal", "Owner", "Health", "Notes"],
  [
    "Helios Retail",
    "$280,000",
    "Enterprise",
    "2026-10-01",
    "Theo Marchetti",
    "Green",
    "Security review scheduled",
  ],
  [
    "Caldera Energy",
    "$160,000",
    "Business Plus",
    "2026-11-20",
    "Rumi Tanaka",
    "Yellow",
    "Awaiting procurement",
  ],
  [
    "Driftwood Media",
    "$94,000",
    "Business",
    "2027-01-14",
    "Naveen Iyer",
    "Green",
    "Pilot expanded to 3 teams",
  ],
  [
    "Ravenwood Legal",
    "$132,000",
    "Enterprise",
    "2026-12-09",
    "Theo Marchetti",
    "Red",
    "Champion changed roles",
  ],
];

/** Lost tab — churned or closed-lost accounts. */
const LOST_GRID: SheetGrid = [
  ["Account", "ARR", "Plan", "Renewal", "Owner", "Health", "Notes"],
  [
    "Quartz Studio",
    "$48,000",
    "Business",
    "2026-04-30",
    "Rumi Tanaka",
    "Red",
    "Chose competitor on price",
  ],
  [
    "Nimbus Travel",
    "$76,000",
    "Business Plus",
    "2026-03-12",
    "Naveen Iyer",
    "Red",
    "Budget cut after reorg",
  ],
];

/** Forecast tab — projected ARR by quarter. */
const FORECAST_GRID: SheetGrid = [
  ["Segment", "ARR", "Plan", "Renewal", "Owner", "Health", "Notes"],
  [
    "Enterprise — Q3",
    "$1,460,000",
    "Enterprise",
    "2026-09-30",
    "Naveen Iyer",
    "Green",
    "Tracking 4% above plan",
  ],
  [
    "Mid-market — Q3",
    "$520,000",
    "Business Plus",
    "2026-09-30",
    "Sasha Levin",
    "Yellow",
    "Pipeline coverage thin",
  ],
  [
    "SMB — Q3",
    "$190,000",
    "Business",
    "2026-09-30",
    "Owen Hart",
    "Green",
    "Self-serve conversion up",
  ],
];

/** Grid contents keyed by tab id. */
export const SHEET_DATA: Readonly<Record<string, SheetGrid>> = {
  customers: CUSTOMERS_GRID,
  pipeline: PIPELINE_GRID,
  lost: LOST_GRID,
  forecast: FORECAST_GRID,
};

/** Parse a currency-style cell string into a number (0 when unparseable). */
export function parseCurrency(value: string): number {
  const n = Number.parseInt(value.replace(/[$,]/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Sum the ARR column of a grid, skipping the header row. */
export function sumArr(grid: SheetGrid): number {
  return grid
    .slice(1)
    .reduce((total, row) => total + parseCurrency(row[ARR_COLUMN] ?? ""), 0);
}

/** Convert a zero-based column index into a spreadsheet letter (0 → A). */
export function columnLetter(index: number): string {
  let i = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

/** Format a cell coordinate into an A1-style reference (row/col zero-based). */
export function cellReference(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}
