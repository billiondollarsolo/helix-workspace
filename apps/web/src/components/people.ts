/* Seed people directory used across shell overlays (command palette,
   notifications, side-panel contacts). Ported from the design handoff
   (components.jsx → PEOPLE). Replace with `GET /api/people` in production. */

export interface Person {
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly dept: string;
}

export const PEOPLE: readonly Person[] = [
  { name: "Mira Okafor", email: "mira@helix.io", role: "Product Lead", dept: "Product" },
  { name: "Jonas Reichert", email: "jonas@helix.io", role: "Eng Manager", dept: "Engineering" },
  { name: "Priya Anand", email: "priya@helix.io", role: "Senior Designer", dept: "Design" },
  { name: "Daniel Cho", email: "daniel@helix.io", role: "Staff Engineer", dept: "Engineering" },
  { name: "Sasha Levin", email: "sasha@helix.io", role: "Recruiter", dept: "People" },
  { name: "Rumi Tanaka", email: "rumi@helix.io", role: "Account Exec", dept: "Sales" },
  { name: "Owen Hart", email: "owen@helix.io", role: "Marketing Manager", dept: "Marketing" },
  { name: "Naveen Iyer", email: "naveen@helix.io", role: "Finance Analyst", dept: "Finance" },
  { name: "Iris Lambert", email: "iris@helix.io", role: "Legal Counsel", dept: "Legal" },
  { name: "Theo Marchetti", email: "theo@helix.io", role: "Customer Success", dept: "Support" },
];

/** The signed-in user. Hard-coded in the prototype; swap for auth context. */
export const CURRENT_USER = {
  name: "Alex Park",
  email: "alex@helix.io",
} as const;
