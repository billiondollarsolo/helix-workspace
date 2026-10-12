import type { Person } from "./company.js";
import type { SeedRandom } from "./random.js";
import { BOOKS, CUSTOMERS, FEATURES, LUNCH_SPOTS, SERVICES } from "./world.js";

export type SpaceTone =
  "team" | "engineering" | "general" | "social" | "it" | "incident" | "launch";

/** Chat handle used by `@mention` parsing: the display name, lower-cased, dot-joined. */
function handle(person: Person): string {
  return person.displayName.toLowerCase().replace(/\s+/gu, ".");
}

/** One chat line in a space of the given tone, optionally mentioning a member. */
export function chatLine(tone: SpaceTone, random: SeedRandom, mention: Person | null): string {
  const feature = random.pick(FEATURES);
  const customer = random.pick(CUSTOMERS).name;
  const service = random.pick(SERVICES);
  const at = mention === null ? "" : `@${handle(mention)} `;
  const lines: Record<SpaceTone, readonly string[]> = {
    team: [
      `${at}can you take a look at the ${feature} doc before standup?`,
      "Pushed the updated numbers to the team drive.",
      `Quick reminder: ${customer} demo is tomorrow at 2.`,
      "Who's around for a 10 minute sync after lunch?",
      `${at}thanks for jumping on that so fast 🙏`,
      "Notes from today's meeting are in the folder.",
      "I'm out Friday, back Monday.",
      `Has anyone heard back from ${customer}?`,
      "Agenda for the weekly is up — add anything you want to cover.",
      "Heads down on the quarterly plan this afternoon.",
    ],
    engineering: [
      `${at}PR for ${feature} is up, would love a review`,
      `Deploying ${service} in 5 minutes, shout if you're mid-test.`,
      `The flaky test in ${service} is back. Quarantining it for now.`,
      "Merged. Thanks for the thorough review!",
      `${at}can you check the staging logs? Seeing 502s from ${service}.`,
      "Rollback done, error rate is back to baseline.",
      "Load test results look good: p95 under 300ms at 2x peak.",
      "I'll take the on-call handoff today.",
      `Started an RFC for ${feature}, comments welcome.`,
      "Bumped the dependency; release notes say no breaking changes.",
    ],
    general: [
      "Welcome to the team, everyone who started this week! 👋",
      `Lunch at ${random.pick(LUNCH_SPOTS)} today, 12:30, all welcome.`,
      "Reminder: all-hands Thursday at 4. Questions in the form.",
      "The coffee machine on 3 is fixed ☕",
      `Huge congrats to the team on closing ${customer}! 🎉`,
      "Office closes early Friday for the building maintenance.",
      "Please submit expense reports by the 5th.",
      "New handbook section on remote work is live in the Company drive.",
    ],
    social: [
      `Finished ${random.pick(BOOKS)} — highly recommend.`,
      "Saturday run: 8am from the office, 5k or 10k.",
      "Who's bringing snacks to the next meetup?",
      "Photo dump from the offsite 📸",
      "Anyone want to start a lunchtime chess club?",
      "That sunset on the way home yesterday 🌅",
    ],
    it: [
      `${at}your new laptop is ready for pickup at the IT desk.`,
      "Reminder: please turn on two-step verification by Friday.",
      "Printer on 2 is back online.",
      "VPN maintenance tonight 10pm–11pm.",
      "I can't connect to the conference room display — any tips?",
      "Fixed — the display needed a firmware update.",
    ],
    incident: [
      `Investigating elevated errors on ${service}.`,
      `${at}paging you in — looks related to the cache change.`,
      "Mitigated. Monitoring for 30 minutes before closing.",
      `Customer impact: ${customer} saw delayed ETAs for ~20 min.`,
      "Postmortem doc started, will share by EOD.",
      "Resolved. Thanks everyone.",
    ],
    launch: [
      `Launch checklist for ${feature} is 80% done.`,
      `${at}blog post draft ready for review.`,
      "Release notes are final.",
      "Help center articles published.",
      "Go/no-go at 10 tomorrow.",
      "We're live! 🚀",
    ],
  };
  return random.pick(lines[tone]);
}

export function directLine(random: SeedRandom, other: Person): string {
  return random.pick([
    `Hey ${other.givenName}, do you have 5 minutes?`,
    "Sure, give me a sec.",
    "Can you send me the link to that doc?",
    "Here you go — it's in the team folder.",
    "Thanks!",
    "Running 5 min late to our 1:1.",
    "No worries.",
    "Did you see the customer's reply?",
    "Yep, I'll answer this afternoon.",
    "Lunch?",
    "Sounds good 👍",
    "Congrats on the launch!",
  ]);
}

export const REACTIONS = ["👍", "🎉", "❤️", "😂", "👀", "🙏", "✅", "🚀"] as const;
