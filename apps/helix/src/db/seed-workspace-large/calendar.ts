/**
 * Seed ~120 calendar events spanning 3 months past + 2 months future.
 *
 * Calendars: d000 group (idx 1..6)
 * Events:    d100 group (threads) + d200 group (cal_events)
 */

import {
  ADMIN_ACTOR,
  USER_ACTOR,
  WORKSPACE_SEED_LARGE_SOURCE,
  daysFromNow,
  grantBoth,
  json,
  uid,
  teamId,
  type SeedSql,
} from "./config.js";

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

const CALENDARS = [
  { idx: 1, name: "Avery Park",        color: "#1a73e8", desc: "Personal calendar",           tz: "America/New_York" },
  { idx: 2, name: "Helix Team",        color: "#137333", desc: "Shared team calendar",         tz: "America/New_York" },
  { idx: 3, name: "Engineering",       color: "#9334e6", desc: "Engineering team calendar",    tz: "America/New_York" },
  { idx: 4, name: "Product & Design",  color: "#e8710a", desc: "Product and design cadence",   tz: "America/New_York" },
  { idx: 5, name: "Customer Calls",    color: "#12b5cb", desc: "External customer meetings",   tz: "America/New_York" },
  { idx: 6, name: "Company",           color: "#f9ab00", desc: "Company-wide events",          tz: "America/New_York" },
];

// ---------------------------------------------------------------------------
// Event definitions
// ---------------------------------------------------------------------------

interface EventDef {
  readonly idx: number;
  readonly calIdx: number;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly dayOffset: number;
  readonly startHour: number;
  readonly durationMin: number;
  readonly recurrence?: string;
  readonly attendeeIdxs?: readonly number[];  // LARGE_TEAM indices (1-based)
  readonly allDay?: boolean;
}

// Spread across -90..+60 days, varied cadence.
const EVENTS: readonly EventDef[] = [
  // Recurring standup
  { idx: 1,  calIdx: 3, title: "Daily standup — Engineering",     description: "Quick sync: yesterday, today, blockers.", location: "Meet",                dayOffset: 0,   startHour: 9,  durationMin: 15,  recurrence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", attendeeIdxs: [1,2,3,8,9,15,23] },
  { idx: 2,  calIdx: 4, title: "Product weekly",                   description: "Product and design weekly sync.",         location: "Conference Room B",   dayOffset: 1,   startHour: 10, durationMin: 60,  recurrence: "FREQ=WEEKLY;BYDAY=TU",              attendeeIdxs: [4,6,10,19] },
  { idx: 3,  calIdx: 2, title: "All-hands",                        description: "Monthly company all-hands.",             location: "Main Hall + Meet",     dayOffset: 10,  startHour: 16, durationMin: 60,  attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
  // 1:1s
  { idx: 4,  calIdx: 1, title: "1:1 with Hannah",                  description: "Weekly engineering 1:1.",                location: "Meet",                dayOffset: 1,   startHour: 14, durationMin: 30,  recurrence: "FREQ=WEEKLY;BYDAY=MO",              attendeeIdxs: [8] },
  { idx: 5,  calIdx: 1, title: "1:1 with Diana",                   description: "Weekly PM sync.",                        location: "Meet",                dayOffset: 2,   startHour: 11, durationMin: 30,  recurrence: "FREQ=WEEKLY;BYDAY=WE",              attendeeIdxs: [4] },
  { idx: 6,  calIdx: 1, title: "1:1 with Ulrich",                  description: "Technical alignment with principal.",    location: "Meet",                dayOffset: 4,   startHour: 15, durationMin: 45,  attendeeIdxs: [21] },
  // Engineering events
  { idx: 7,  calIdx: 3, title: "Sprint planning",                   description: "Plan the next two-week sprint.",         location: "Conference Room A",   dayOffset: 7,   startHour: 10, durationMin: 90,  recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",   attendeeIdxs: [1,2,3,8,9,15,16,23] },
  { idx: 8,  calIdx: 3, title: "Sprint review",                     description: "Demo completed sprint work.",            location: "Conference Room A",   dayOffset: 14,  startHour: 14, durationMin: 60,  attendeeIdxs: [1,2,3,4,8,9,15,16] },
  { idx: 9,  calIdx: 3, title: "Sprint retrospective",              description: "What went well and what to improve.",   location: "Conference Room B",   dayOffset: 14,  startHour: 15, durationMin: 60,  attendeeIdxs: [1,2,3,8,9,15,16,23] },
  { idx: 10, calIdx: 3, title: "Architecture review",               description: "Review system design proposals.",        location: "Conference Room A",   dayOffset: 5,   startHour: 13, durationMin: 90,  attendeeIdxs: [1,2,8,21] },
  { idx: 11, calIdx: 3, title: "On-call handoff",                   description: "Weekly on-call rotation handoff.",       location: "Meet",                dayOffset: 0,   startHour: 9,  durationMin: 30,  recurrence: "FREQ=WEEKLY;BYDAY=MO",              attendeeIdxs: [9,15,23] },
  { idx: 12, calIdx: 3, title: "Incident review — search lag",      description: "Blameless retro on last week's incident.", location: "Conference Room B", dayOffset: -4,  startHour: 11, durationMin: 45,  attendeeIdxs: [1,9,15,21] },
  { idx: 13, calIdx: 3, title: "Security review",                   description: "Quarterly security review with Gabriel.", location: "Conference Room A", dayOffset: 6,   startHour: 10, durationMin: 60,  attendeeIdxs: [7,21] },
  { idx: 14, calIdx: 3, title: "Database migration planning",       description: "Plan the Postgres version upgrade.",     location: "Meet",                dayOffset: 8,   startHour: 14, durationMin: 60,  attendeeIdxs: [1,9,15,21] },
  { idx: 15, calIdx: 3, title: "QA handoff — release 2.8",         description: "Hand off release 2.8 to QA.",            location: "Conference Room B",   dayOffset: 11,  startHour: 13, durationMin: 45,  attendeeIdxs: [2,3,16] },
  { idx: 16, calIdx: 3, title: "Mobile sync",                       description: "Mobile feature alignment with Kai.",     location: "Meet",                dayOffset: 3,   startHour: 11, durationMin: 30,  attendeeIdxs: [11,8] },
  // Product & design
  { idx: 17, calIdx: 4, title: "Design critique",                   description: "Critique in-progress design work.",      location: "Conference Room B",   dayOffset: -3,  startHour: 15, durationMin: 60,  attendeeIdxs: [6,10,19] },
  { idx: 18, calIdx: 4, title: "User research readout",             description: "Fiona presents April UX research.",      location: "Conference Room A",   dayOffset: 2,   startHour: 14, durationMin: 60,  attendeeIdxs: [4,6,10,19] },
  { idx: 19, calIdx: 4, title: "Roadmap review — Q3",               description: "Lock Q3 roadmap.",                       location: "Conference Room A",   dayOffset: 1,   startHour: 13, durationMin: 90,  attendeeIdxs: [1,4,6,8,21] },
  { idx: 20, calIdx: 4, title: "Content calendar planning",         description: "Plan content for June–August.",          location: "Meet",                dayOffset: 9,   startHour: 11, durationMin: 60,  attendeeIdxs: [4,10,17] },
  { idx: 21, calIdx: 4, title: "Assistant UX review",               description: "Review assistant interaction flows.",    location: "Conference Room B",   dayOffset: 4,   startHour: 15, durationMin: 45,  attendeeIdxs: [4,6,19] },
  { idx: 22, calIdx: 4, title: "OKR check-in",                      description: "Monthly OKR progress check.",            location: "Meet",                dayOffset: 12,  startHour: 10, durationMin: 60,  recurrence: "FREQ=MONTHLY;BYMONTHDAY=15",         attendeeIdxs: [4,8,21] },
  // Customer calls
  { idx: 23, calIdx: 5, title: "Northwind QBR",                     description: "Quarterly business review with Northwind.", location: "Meet",            dayOffset: 5,   startHour: 13, durationMin: 60,  attendeeIdxs: [13,14] },
  { idx: 24, calIdx: 5, title: "Acme Corp onboarding — session 1",  description: "First onboarding session for Acme Corp.", location: "Meet",              dayOffset: 3,   startHour: 10, durationMin: 60,  attendeeIdxs: [13,14] },
  { idx: 25, calIdx: 5, title: "Acme Corp onboarding — session 2",  description: "Second onboarding session.",             location: "Meet",                dayOffset: 10,  startHour: 10, durationMin: 60,  attendeeIdxs: [13,14] },
  { idx: 26, calIdx: 5, title: "Riviera Hotels — renewal call",     description: "Discuss renewal terms.",                 location: "Meet",                dayOffset: 7,   startHour: 14, durationMin: 45,  attendeeIdxs: [13,14] },
  { idx: 27, calIdx: 5, title: "Beacon Analytics — expansion",      description: "Expansion and upsell discussion.",        location: "Meet",               dayOffset: 9,   startHour: 11, durationMin: 30,  attendeeIdxs: [13,20] },
  { idx: 28, calIdx: 5, title: "Orion Health — feature request review", description: "Review their feature request backlog.", location: "Meet",             dayOffset: 13,  startHour: 15, durationMin: 45,  attendeeIdxs: [13,14] },
  // Company-wide
  { idx: 29, calIdx: 6, title: "Company offsite — day 1",           description: "Strategy and planning day.",             location: "The Foundry",         dayOffset: 21,  startHour: 9,  durationMin: 480, allDay: false, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
  { idx: 30, calIdx: 6, title: "Company offsite — day 2",           description: "Workshops and deep dives.",              location: "The Foundry",         dayOffset: 22,  startHour: 9,  durationMin: 480, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
  { idx: 31, calIdx: 6, title: "Company offsite — day 3",           description: "Retrospective and social.",              location: "The Foundry",         dayOffset: 23,  startHour: 9,  durationMin: 480, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
  { idx: 32, calIdx: 6, title: "Engineering hiring day",            description: "Full-day hiring loop for three open roles.", location: "Conference Room A", dayOffset: 15,  startHour: 9, durationMin: 480, attendeeIdxs: [1,8,21,22] },
  { idx: 33, calIdx: 6, title: "New hire orientation",              description: "Orientation for new starters.",          location: "Training Room",       dayOffset: 18,  startHour: 9,  durationMin: 240, attendeeIdxs: [22] },
  { idx: 34, calIdx: 6, title: "Budget review — FY2026 Q3",         description: "Finance presents Q3 budget.",            location: "Board Room",          dayOffset: 20,  startHour: 14, durationMin: 90,  attendeeIdxs: [5,8,21] },
  { idx: 35, calIdx: 6, title: "Marketing campaign kickoff",        description: "June campaign kickoff.",                 location: "Conference Room A",   dayOffset: 16,  startHour: 10, durationMin: 60,  attendeeIdxs: [10,17,19,20] },
  // Personal calendar events
  { idx: 36, calIdx: 1, title: "Doctor appointment",                description: "Annual physical.", location: "City Medical Center",   dayOffset: 6,   startHour: 9,  durationMin: 60 },
  { idx: 37, calIdx: 1, title: "Lunch with Ulrich",                 description: "Catch-up over lunch.",               location: "Café Lumen",          dayOffset: 3,   startHour: 12, durationMin: 60,  attendeeIdxs: [21] },
  { idx: 38, calIdx: 1, title: "Focus block — deep work",           description: "Uninterrupted deep work.",           location: "",                    dayOffset: 2,   startHour: 9,  durationMin: 180 },
  { idx: 39, calIdx: 1, title: "Focus block — deep work",           description: "Uninterrupted deep work.",           location: "",                    dayOffset: 9,   startHour: 9,  durationMin: 180 },
  { idx: 40, calIdx: 1, title: "Haircut",                           description: "", location: "Style Studio",                        dayOffset: 11,  startHour: 18, durationMin: 30 },
  { idx: 41, calIdx: 1, title: "Coffee with Nina",                  description: "Catch-up with customer success.",    location: "Third Street Coffee",  dayOffset: 7,   startHour: 10, durationMin: 30,  attendeeIdxs: [14] },
  { idx: 42, calIdx: 1, title: "Gym",                               description: "", location: "Helix Fitness Center",               dayOffset: 1,   startHour: 7,  durationMin: 60 },
  { idx: 43, calIdx: 1, title: "Gym",                               description: "", location: "Helix Fitness Center",               dayOffset: 3,   startHour: 7,  durationMin: 60 },
  { idx: 44, calIdx: 1, title: "Gym",                               description: "", location: "Helix Fitness Center",               dayOffset: 5,   startHour: 7,  durationMin: 60 },
  // Past events
  { idx: 45, calIdx: 3, title: "Q2 retrospective",                  description: "End-of-quarter retrospective.",      location: "Conference Room A",   dayOffset: -14, startHour: 14, durationMin: 90,  attendeeIdxs: [1,2,3,8,9,15,16,21,23] },
  { idx: 46, calIdx: 3, title: "Production release — v2.7",        description: "Ship v2.7 to production.",           location: "Meet",                dayOffset: -7,  startHour: 14, durationMin: 30,  attendeeIdxs: [1,9,23] },
  { idx: 47, calIdx: 3, title: "Postmortem — search outage",        description: "Root cause analysis.",               location: "Conference Room B",   dayOffset: -10, startHour: 11, durationMin: 60,  attendeeIdxs: [1,9,15,21] },
  { idx: 48, calIdx: 4, title: "Design review — mail inbox",        description: "Crit on mail inbox redesign.",       location: "Conference Room B",   dayOffset: -5,  startHour: 15, durationMin: 45,  attendeeIdxs: [6,10,19] },
  { idx: 49, calIdx: 4, title: "User interview — enterprise pilot", description: "Research interview with Northwind pilot user.", location: "Meet", dayOffset: -8,  startHour: 10, durationMin: 45,  attendeeIdxs: [6,14] },
  { idx: 50, calIdx: 5, title: "Summit Capital — intro call",       description: "Introductory call with new prospect.", location: "Meet",              dayOffset: -3,  startHour: 13, durationMin: 30,  attendeeIdxs: [13,20] },
  { idx: 51, calIdx: 5, title: "Harbor Tech — onboarding kickoff",  description: "Onboarding kickoff for Harbor Tech.", location: "Meet",               dayOffset: -6,  startHour: 10, durationMin: 60,  attendeeIdxs: [13,14] },
  { idx: 52, calIdx: 6, title: "Engineering all-hands",             description: "Engineering-wide all-hands.",        location: "Main Hall",           dayOffset: -20, startHour: 16, durationMin: 60,  attendeeIdxs: [1,2,3,7,8,9,11,15,16,21,23] },
  { idx: 53, calIdx: 6, title: "Welcome lunch — new starters",      description: "Lunch for the new team members.",    location: "Noodle House",        dayOffset: -21, startHour: 12, durationMin: 90,  attendeeIdxs: [1,2,3,4,5,6,7,8] },
  { idx: 54, calIdx: 2, title: "Lunch & learn — Sheets formula engine", description: "Evan demos the formula parser.", location: "Conference Room B",  dayOffset: -9,  startHour: 12, durationMin: 60,  attendeeIdxs: [1,2,3,4,5] },
  { idx: 55, calIdx: 2, title: "Lunch & learn — security best practices", description: "Gabriel presents security.", location: "Conference Room B",    dayOffset: -16, startHour: 12, durationMin: 60,  attendeeIdxs: [1,2,3,4,7] },
  // More past engineering events
  { idx: 56, calIdx: 3, title: "Daily standup — Engineering",       description: "Quick sync.",                        location: "Meet",                dayOffset: -1,  startHour: 9,  durationMin: 15,  attendeeIdxs: [1,2,3,8,9,15,23] },
  { idx: 57, calIdx: 3, title: "Daily standup — Engineering",       description: "Quick sync.",                        location: "Meet",                dayOffset: -2,  startHour: 9,  durationMin: 15,  attendeeIdxs: [1,2,3,8,9,15,23] },
  { idx: 58, calIdx: 3, title: "Daily standup — Engineering",       description: "Quick sync.",                        location: "Meet",                dayOffset: -3,  startHour: 9,  durationMin: 15,  attendeeIdxs: [1,2,3,8,9,15,23] },
  { idx: 59, calIdx: 3, title: "Daily standup — Engineering",       description: "Quick sync.",                        location: "Meet",                dayOffset: -4,  startHour: 9,  durationMin: 15,  attendeeIdxs: [1,2,3,8,9,15,23] },
  { idx: 60, calIdx: 3, title: "Daily standup — Engineering",       description: "Quick sync.",                        location: "Meet",                dayOffset: -7,  startHour: 9,  durationMin: 15,  attendeeIdxs: [1,2,3,8,9,15,23] },
  // Future events
  { idx: 61, calIdx: 3, title: "Release planning — v2.9",           description: "Plan v2.9 release scope.",           location: "Conference Room A",   dayOffset: 17,  startHour: 10, durationMin: 60,  attendeeIdxs: [1,2,8,21] },
  { idx: 62, calIdx: 4, title: "Beta feedback session",             description: "Review beta feedback from enterprise pilot users.", location: "Meet", dayOffset: 19,  startHour: 14, durationMin: 60,  attendeeIdxs: [4,6,14] },
  { idx: 63, calIdx: 5, title: "Vantage Retail — discovery call",   description: "First call with Vantage Retail.",    location: "Meet",                dayOffset: 24,  startHour: 13, durationMin: 45,  attendeeIdxs: [13,20] },
  { idx: 64, calIdx: 2, title: "Team offsite planning",             description: "Finalize agenda and logistics.",     location: "Conference Room B",   dayOffset: 25,  startHour: 10, durationMin: 60,  attendeeIdxs: [4,8,22] },
  { idx: 65, calIdx: 6, title: "Board presentation",                description: "Present Q2 results and Q3 plan to board.", location: "Board Room", dayOffset: 28,  startHour: 9,  durationMin: 120, attendeeIdxs: [5,8,21] },
  // Past personal
  { idx: 66, calIdx: 1, title: "Dentist",                           description: "", location: "Downtown Dental",                    dayOffset: -15, startHour: 14, durationMin: 60 },
  { idx: 67, calIdx: 1, title: "Coffee with Alex",                  description: "Catch-up with staff engineer.",      location: "Third Street Coffee",  dayOffset: -11, startHour: 10, durationMin: 30,  attendeeIdxs: [1] },
  { idx: 68, calIdx: 1, title: "Gym",                               description: "", location: "Helix Fitness Center",               dayOffset: -2,  startHour: 7,  durationMin: 60 },
  { idx: 69, calIdx: 1, title: "Gym",                               description: "", location: "Helix Fitness Center",               dayOffset: -4,  startHour: 7,  durationMin: 60 },
  { idx: 70, calIdx: 1, title: "1:1 with Hannah",                   description: "Weekly engineering 1:1 (past).",     location: "Meet",                dayOffset: -7,  startHour: 14, durationMin: 30,  attendeeIdxs: [8] },
  { idx: 71, calIdx: 1, title: "1:1 with Diana",                    description: "Weekly PM sync (past).",             location: "Meet",                dayOffset: -5,  startHour: 11, durationMin: 30,  attendeeIdxs: [4] },
  // More engineering
  { idx: 72, calIdx: 3, title: "Backend chapter meeting",           description: "Backend team sync.",                 location: "Conference Room B",   dayOffset: 4,   startHour: 14, durationMin: 45,  attendeeIdxs: [1,2,8,21] },
  { idx: 73, calIdx: 3, title: "Frontend chapter meeting",          description: "Frontend team sync.",                location: "Conference Room B",   dayOffset: 4,   startHour: 15, durationMin: 45,  attendeeIdxs: [3,11,8] },
  { idx: 74, calIdx: 3, title: "Infra review",                      description: "Review infrastructure roadmap.",     location: "Conference Room A",   dayOffset: 6,   startHour: 14, durationMin: 60,  attendeeIdxs: [9,15,23,21] },
  { idx: 75, calIdx: 4, title: "Competitor analysis readout",       description: "Evan presents competitive landscape.", location: "Conference Room A", dayOffset: 8,   startHour: 11, durationMin: 45,  attendeeIdxs: [4,5,21] },
  { idx: 76, calIdx: 5, title: "PineCrest Schools — check-in",      description: "Monthly check-in with PineCrest.",   location: "Meet",                dayOffset: 12,  startHour: 10, durationMin: 30,  attendeeIdxs: [14] },
  { idx: 77, calIdx: 5, title: "Nexus Media — technical deep dive",  description: "Technical session with Nexus Media.", location: "Meet",              dayOffset: 14,  startHour: 14, durationMin: 90,  attendeeIdxs: [1,13] },
  { idx: 78, calIdx: 2, title: "Hiring sync",                       description: "Weekly hiring pipeline review.",     location: "Meet",                dayOffset: 2,   startHour: 15, durationMin: 30,  recurrence: "FREQ=WEEKLY;BYDAY=TH",              attendeeIdxs: [8,22] },
  { idx: 79, calIdx: 6, title: "Company birthday celebration",      description: "Helix turns 4!",                    location: "Main Hall",           dayOffset: 30,  startHour: 17, durationMin: 120, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
  { idx: 80, calIdx: 3, title: "Chaos engineering exercise",        description: "Practice failure injection in staging.", location: "Meet",             dayOffset: 13,  startHour: 14, durationMin: 120, attendeeIdxs: [9,15,21,23] },
  // Past events (days -20..-90)
  { idx: 81, calIdx: 3, title: "Q2 sprint planning kick-off",       description: "Planning for the first Q2 sprint.",  location: "Conference Room A",   dayOffset: -30, startHour: 10, durationMin: 90,  attendeeIdxs: [1,2,3,8,9,15,16,21,23] },
  { idx: 82, calIdx: 4, title: "Q2 roadmap review",                 description: "Lock Q2 roadmap.",                   location: "Conference Room A",   dayOffset: -45, startHour: 13, durationMin: 90,  attendeeIdxs: [1,4,6,8,21] },
  { idx: 83, calIdx: 3, title: "Production release — v2.6",        description: "Ship v2.6 to production.",           location: "Meet",                dayOffset: -35, startHour: 15, durationMin: 30,  attendeeIdxs: [1,9,23] },
  { idx: 84, calIdx: 5, title: "Orion Health — onboarding session", description: "First onboarding session.",          location: "Meet",                dayOffset: -25, startHour: 10, durationMin: 60,  attendeeIdxs: [13,14] },
  { idx: 85, calIdx: 2, title: "All-hands (past)",                  description: "Monthly all-hands.",                location: "Main Hall + Meet",     dayOffset: -20, startHour: 16, durationMin: 60,  attendeeIdxs: [1,2,3,4,5,6,7,8,9,10] },
  { idx: 86, calIdx: 6, title: "Q1 kickoff",                        description: "Company Q1 kickoff.",               location: "Main Hall",           dayOffset: -88, startHour: 9,  durationMin: 240, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
  { idx: 87, calIdx: 3, title: "Tech debt review — Q1",             description: "Review Q1 tech debt backlog.",       location: "Conference Room B",   dayOffset: -60, startHour: 14, durationMin: 60,  attendeeIdxs: [1,2,8,21] },
  { idx: 88, calIdx: 4, title: "Annual design system review",       description: "Full review of design system.",      location: "Conference Room A",   dayOffset: -42, startHour: 10, durationMin: 120, attendeeIdxs: [6,10,19] },
  { idx: 89, calIdx: 1, title: "Annual performance review prep",    description: "Prepare self-assessment.",           location: "",                    dayOffset: -55, startHour: 15, durationMin: 60 },
  { idx: 90, calIdx: 1, title: "Annual performance review",         description: "Annual review with Hannah.",         location: "Meet",                dayOffset: -50, startHour: 14, durationMin: 60,  attendeeIdxs: [8] },
  // Extra events to reach ~120 total
  { idx: 91,  calIdx: 3, title: "Code review session",              description: "Group code review.",                location: "Meet",                dayOffset: 2,   startHour: 16, durationMin: 60,  attendeeIdxs: [1,2,3] },
  { idx: 92,  calIdx: 3, title: "Documentation day",                description: "Dedicated docs day.",               location: "",                    dayOffset: 16,  startHour: 9,  durationMin: 480, allDay: true,  attendeeIdxs: [1,2,3,8,17] },
  { idx: 93,  calIdx: 4, title: "Persona workshop",                 description: "Collaborative persona building.",   location: "Conference Room A",   dayOffset: 15,  startHour: 9,  durationMin: 180, attendeeIdxs: [4,6,10,14,19] },
  { idx: 94,  calIdx: 5, title: "Nexus Media — renewal",            description: "Contract renewal discussion.",      location: "Meet",                dayOffset: 26,  startHour: 14, durationMin: 45,  attendeeIdxs: [13,20] },
  { idx: 95,  calIdx: 3, title: "Mobile release planning",          description: "Plan mobile release schedule.",     location: "Meet",                dayOffset: 19,  startHour: 11, durationMin: 45,  attendeeIdxs: [11,8,4] },
  { idx: 96,  calIdx: 2, title: "Cross-functional sync",            description: "Cross-team alignment meeting.",     location: "Conference Room A",   dayOffset: 3,   startHour: 13, durationMin: 45,  attendeeIdxs: [1,4,6,8,14,21] },
  { idx: 97,  calIdx: 6, title: "Internal hackathon kick-off",      description: "Two-day internal hackathon.",        location: "Main Hall",           dayOffset: 32,  startHour: 9,  durationMin: 240, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12] },
  { idx: 98,  calIdx: 6, title: "Internal hackathon demos",         description: "Hackathon project demos.",          location: "Main Hall",           dayOffset: 33,  startHour: 14, durationMin: 120, attendeeIdxs: [1,2,3,4,5,6,7,8,9,10,11,12] },
  { idx: 99,  calIdx: 4, title: "Pricing review",                   description: "Review enterprise pricing model.",  location: "Board Room",          dayOffset: 22,  startHour: 13, durationMin: 60,  attendeeIdxs: [4,5,20,21] },
  { idx: 100, calIdx: 3, title: "Load testing session",             description: "Load test the new search path.",   location: "Meet",                dayOffset: 10,  startHour: 14, durationMin: 90,  attendeeIdxs: [1,5,9,15] },
  { idx: 101, calIdx: 1, title: "Focus block — architecture doc",   description: "Write architecture overview update.", location: "",                 dayOffset: 8,   startHour: 10, durationMin: 120 },
  { idx: 102, calIdx: 5, title: "Summit Capital — demo",            description: "Product demo for Summit Capital.",   location: "Meet",               dayOffset: 18,  startHour: 10, durationMin: 60,  attendeeIdxs: [13,20,4] },
  { idx: 103, calIdx: 3, title: "Dependency upgrade review",        description: "Review major dependency upgrades.", location: "Meet",                dayOffset: 11,  startHour: 15, durationMin: 45,  attendeeIdxs: [2,7,9] },
  { idx: 104, calIdx: 4, title: "Content review — blog posts",      description: "Review June blog calendar.",        location: "Meet",                dayOffset: 6,   startHour: 11, durationMin: 30,  attendeeIdxs: [10,17] },
  { idx: 105, calIdx: 2, title: "Lunch & learn — observability",    description: "Omar presents monitoring setup.",   location: "Conference Room B",   dayOffset: 20,  startHour: 12, durationMin: 60,  attendeeIdxs: [1,2,9,15,23] },
  { idx: 106, calIdx: 3, title: "API versioning discussion",        description: "Decide v2 vs v3 API strategy.",     location: "Conference Room A",   dayOffset: 14,  startHour: 13, durationMin: 60,  attendeeIdxs: [1,2,8,13,21] },
  { idx: 107, calIdx: 1, title: "Team dinner",                      description: "Informal team dinner.",             location: "The Collective",      dayOffset: 17,  startHour: 19, durationMin: 120 },
  { idx: 108, calIdx: 6, title: "Legal compliance workshop",        description: "GDPR and data handling workshop.",  location: "Training Room",       dayOffset: 24,  startHour: 14, durationMin: 120, attendeeIdxs: [7,12,9] },
  { idx: 109, calIdx: 4, title: "A/B test review",                  description: "Review results of latest A/B tests.", location: "Conference Room B", dayOffset: 13,  startHour: 10, durationMin: 45,  attendeeIdxs: [4,5,6] },
  { idx: 110, calIdx: 3, title: "Feature flag audit",               description: "Audit and clean up feature flags.", location: "Meet",                dayOffset: 7,   startHour: 15, durationMin: 30,  attendeeIdxs: [1,2,3,9] },
  { idx: 111, calIdx: 5, title: "PineCrest Schools — expansion",    description: "Expansion discussion with PineCrest.", location: "Meet",              dayOffset: 29,  startHour: 11, durationMin: 45,  attendeeIdxs: [14,20] },
  { idx: 112, calIdx: 3, title: "Cache invalidation discussion",    description: "Design cache invalidation strategy.", location: "Conference Room A", dayOffset: 5,   startHour: 15, durationMin: 60,  attendeeIdxs: [1,2,9,21] },
  { idx: 113, calIdx: 4, title: "Technical writing review",         description: "Review API docs with Quinn.",        location: "Meet",               dayOffset: 4,   startHour: 14, durationMin: 30,  attendeeIdxs: [1,17] },
  { idx: 114, calIdx: 1, title: "1:1 with Ulrich (past)",           description: "Technical alignment.",              location: "Meet",                dayOffset: -12, startHour: 15, durationMin: 45,  attendeeIdxs: [21] },
  { idx: 115, calIdx: 3, title: "Incident debrief — mail drops",    description: "Blameless debrief on mail drops.",   location: "Conference Room B",   dayOffset: -18, startHour: 11, durationMin: 45,  attendeeIdxs: [1,9,15,21] },
  { idx: 116, calIdx: 2, title: "Team trivia night",                description: "Virtual team trivia.",               location: "Meet",                dayOffset: 40,  startHour: 18, durationMin: 60,  attendeeIdxs: [1,2,3,4,5,6,7,8,9,10] },
  { idx: 117, calIdx: 6, title: "Q3 planning kick-off",             description: "Kick off Q3 planning cycle.",        location: "Main Hall",           dayOffset: 35,  startHour: 9,  durationMin: 180, attendeeIdxs: [1,4,5,8,21] },
  { idx: 118, calIdx: 4, title: "Onboarding flow review",           description: "Review and improve onboarding.",     location: "Conference Room B",   dayOffset: 16,  startHour: 14, durationMin: 60,  attendeeIdxs: [4,6,14,19] },
  { idx: 119, calIdx: 3, title: "Infra migration retrospective",    description: "Retro on Q1 infra migration.",       location: "Conference Room A",   dayOffset: -40, startHour: 14, durationMin: 60,  attendeeIdxs: [9,15,21,23] },
  { idx: 120, calIdx: 1, title: "Quarterly personal goals review",  description: "Review personal Q3 goals.",          location: "",                    dayOffset: 45,  startHour: 9,  durationMin: 60 },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedCalendar(sql: SeedSql, orgId: string): Promise<{ calendars: number; events: number }> {
  // Upsert calendars.
  for (const cal of CALENDARS) {
    const calId = uid("d000", cal.idx);
    await sql`
      insert into cal_calendars (id, org_id, owner_actor_id, name, color, timezone, description, metadata)
      values (
        ${calId}, ${orgId}, ${ADMIN_ACTOR}, ${cal.name}, ${cal.color}, ${cal.tz}, ${cal.desc},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })}
      )
      on conflict (id) do update set name = excluded.name, color = excluded.color, description = excluded.description, metadata = excluded.metadata, updated_at = now()
    `;
    for (const [ai, actorId] of [ADMIN_ACTOR, USER_ACTOR].entries()) {
      await sql`
        insert into cal_calendar_memberships (org_id, calendar_id, actor_id, role, visible, sort_order)
        values (${orgId}, ${calId}, ${actorId}, ${actorId === ADMIN_ACTOR ? "owner" : "writer"}, true, ${cal.idx * 10 + ai})
        on conflict (actor_id, calendar_id) do nothing
      `;
    }
    await grantBoth(sql, orgId, "calendar", calId, "owner");
  }

  // Lookup tables for teammate emails/names (used inside the event loop).
  const TEAM_EMAILS = ["alex.torres","ben.hayes","celia.wright","diana.singh","evan.brooks","fiona.marsh","gabriel.luna","hannah.price","ivan.petrov","jade.osei","kai.nakamura","lena.fischer","marco.vitale","nina.patel","omar.hassan","petra.novak","quinn.reed","rosa.kim","sam.walker","tara.chan","ulrich.weber","vera.stone","will.cross"];
  const TEAM_NAMES  = ["Alex Torres","Ben Hayes","Celia Wright","Diana Singh","Evan Brooks","Fiona Marsh","Gabriel Luna","Hannah Price","Ivan Petrov","Jade Osei","Kai Nakamura","Lena Fischer","Marco Vitale","Nina Patel","Omar Hassan","Petra Novak","Quinn Reed","Rosa Kim","Sam Walker","Tara Chan","Ulrich Weber","Vera Stone","Will Cross"];

  // Upsert events.
  for (const ev of EVENTS) {
    const threadId = uid("d100", ev.idx);
    const eventId  = uid("d200", ev.idx);
    const startsAt = daysFromNow(ev.dayOffset, ev.startHour, 0);
    const endsAt   = new Date(startsAt.getTime() + ev.durationMin * 60_000);
    const isPast   = ev.dayOffset < 0;

    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'calendar', ${ev.title}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict (id) do nothing
    `;
    await sql`
      insert into cal_events (
        id, org_id, calendar_id, thread_id, uid, title, description, location,
        starts_at, ends_at, timezone, all_day, status, recurrence_rule,
        organizer_actor_id, organizer_email, metadata
      )
      values (
        ${eventId}, ${orgId}, ${uid("d000", ev.calIdx)}, ${threadId},
        ${`large-event-${String(ev.idx)}@helix.local`},
        ${ev.title}, ${ev.description}, ${ev.location},
        ${startsAt}, ${endsAt}, 'America/New_York', ${ev.allDay === true},
        'confirmed', ${ev.recurrence ?? null},
        ${ADMIN_ACTOR}, 'admin@helix.local',
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, visibility: "default" })}
      )
      on conflict (id) do update set
        title       = excluded.title,
        description = excluded.description,
        starts_at   = excluded.starts_at,
        ends_at     = excluded.ends_at,
        metadata    = excluded.metadata,
        updated_at  = now()
    `;

    // Organizer attendee.
    await sql`
      insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata)
      values (${orgId}, ${eventId}, ${ADMIN_ACTOR}, 'admin@helix.local', 'Avery Park',
        'required', 'accepted', true, ${`rsvp-lg-${eventId}-org`},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict do nothing
    `;
    // user@helix.local.
    await sql`
      insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata)
      values (${orgId}, ${eventId}, ${USER_ACTOR}, 'user@helix.local', 'Riley Chen',
        'required', ${isPast ? "accepted" : ev.idx % 5 === 0 ? "tentative" : "accepted"},
        false, ${`rsvp-lg-${eventId}-user`},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
      on conflict do nothing
    `;
    // Teammate attendees.
    for (const tIdx of ev.attendeeIdxs ?? []) {
      const emailLocal = TEAM_EMAILS[tIdx - 1] ?? "unknown";
      const displayName = TEAM_NAMES[tIdx - 1] ?? "Unknown";
      const member = { id: teamId(tIdx), email: `${emailLocal}@helix.local`, name: displayName };
      await sql`
        insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata)
        values (${orgId}, ${eventId}, ${member.id}, ${member.email}, ${member.name},
          'required', ${isPast ? "accepted" : "needs_action"}, false,
          ${`rsvp-lg-${eventId}-${member.id}`},
          ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })})
        on conflict do nothing
      `;
    }
    await grantBoth(sql, orgId, "thread", threadId, "owner");
    await grantBoth(sql, orgId, "event", eventId, "owner");
  }

  return { calendars: CALENDARS.length, events: EVENTS.length };
}
