import { localDateTimeToInstant } from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import { PostgresCalendarSchedulingStore } from "../../platform/calendar/scheduling.js";
import type { CalendarAttendeeInput } from "../../platform/calendar/store.js";
import type { CalendarResponseStatus } from "../../platform/calendar/types.js";
import { createMeetConferenceProvider } from "../../platform/meet/conference.js";
import { activePeople, COMPANY, DEPARTMENTS, type Person } from "./company.js";
import { mapLimit } from "./concurrency.js";
import type { Directory } from "./directory.js";
import { SeedRandom, seedUuid, TIME } from "./random.js";
import type { DemoRuntime } from "./runtime.js";
import { BOOKS, CUSTOMERS, externalAddress, FEATURES } from "./world.js";

export interface CalendarSeed {
  readonly series: number;
  readonly events: number;
  readonly withMeet: number;
  readonly pastMeetings: number;
  readonly todaysMeetings: number;
  readonly sharedCalendars: number;
}

interface EventPlan {
  readonly organizer: Person;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly startsAt: Date;
  readonly minutes: number;
  readonly allDay?: boolean;
  readonly rrule?: string;
  readonly attendees: readonly Person[];
  readonly external?: readonly { readonly address: string; readonly name: string }[];
  readonly meet: boolean;
  /** Key of a shared calendar to put the event on; the organizer's own calendar otherwise. */
  readonly calendar?: string;
  readonly metadata?: JsonObject;
  /** Probability an attendee has answered, and how. */
  readonly rsvp: "mostly-yes" | "mixed" | "fresh";
}

/** A shared calendar: owned by one person and followed by the rest. */
interface SharedCalendar {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly owner: Person;
  readonly members: readonly Person[];
  readonly role: "reader" | "writer";
}

const DEPARTMENT_COLORS: Readonly<Record<string, string>> = {
  leadership: "slate",
  engineering: "blue",
  product: "violet",
  design: "pink",
  sales: "orange",
  support: "teal",
  marketing: "fuchsia",
  finance: "olive",
  people: "green",
  legal: "brown",
  operations: "amber",
};

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"] as const;

/** A Quillfeather wall-clock time (America/New_York) `daysFromNow` days away. */
function local(runtime: DemoRuntime, daysFromNow: number, time: string): Date {
  const day = new Date(runtime.timeline.now.getTime() + daysFromNow * TIME.DAY);
  return localDateTimeToInstant(`${day.toISOString().slice(0, 10)}T${time}:00`, COMPANY.timezone);
}

/** The most recent `weekday` (1 = Monday) on or before `daysAgo` days ago. */
function weekdayBefore(runtime: DemoRuntime, daysAgo: number, weekday: number): number {
  const day = new Date(runtime.timeline.now.getTime() - daysAgo * TIME.DAY);
  const offset = (day.getUTCDay() - weekday + 7) % 7;
  return -(daysAgo + offset);
}

/**
 * Calendars: recurring 1:1s, standups, team meetings and all-hands; one-off
 * customer calls, reviews and interviews; holidays, out-of-office and focus
 * time. Events with video calls get a Meet room through the same conference
 * provider the Calendar tools use.
 */
export async function seedCalendar(
  runtime: DemoRuntime,
  directory: Directory,
): Promise<CalendarSeed> {
  const people = activePeople(directory.people);
  const random = SeedRandom.stream("calendar");
  const ceo = directory.byKey.get("person-0") as Person;
  const lead = (key: string) =>
    people.find((person) => person.department === key && person.managerKey === "person-0");
  const conference = createMeetConferenceProvider({
    store: runtime.meet,
    jwtSubject: runtime.env.MEET_JITSI_DOMAIN ?? "meet.localhost",
    jitsiPublicUrl: runtime.env.MEET_JITSI_PUBLIC_URL,
    publicBaseUrl:
      runtime.env.HELIX_PUBLIC_URL ?? runtime.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  });
  const plans: EventPlan[] = [];
  const history = runtime.timeline.historyDays;
  const peopleLead = lead("people") ?? ceo;
  const engineeringLead = lead("engineering");

  // Team calendars (owned by the lead, writable by the department), the company
  // holidays everyone follows, and the engineering on-call rotation.
  const calendarDefs: SharedCalendar[] = [];
  for (const department of DEPARTMENTS) {
    const owner = lead(department.key);
    const members = people.filter(
      (person) => person.department === department.key && person !== owner,
    );
    if (owner === undefined || members.length === 0) continue;
    calendarDefs.push({
      key: `team-${department.key}`,
      name: `${department.name} team`,
      color: DEPARTMENT_COLORS[department.key] ?? "blue",
      owner,
      members,
      role: "writer",
    });
  }
  calendarDefs.push({
    key: "holidays",
    name: "Company holidays",
    color: "red",
    owner: peopleLead,
    members: people.filter((person) => person !== peopleLead),
    role: "reader",
  });
  const onCall = people.filter(
    (person) => person.department === "engineering" && person !== engineeringLead,
  );
  if (engineeringLead !== undefined && onCall.length > 0) {
    calendarDefs.push({
      key: "on-call",
      name: "On-call",
      color: "coral",
      owner: engineeringLead,
      members: onCall,
      role: "reader",
    });
  }
  const sharedIds = new Map<string, string>();
  for (const calendar of calendarDefs) {
    const created = await runtime.calendar.createCalendar({
      orgId: runtime.orgId,
      actorId: calendar.owner.actorId,
      name: calendar.name,
      color: calendar.color,
    });
    sharedIds.set(calendar.key, created.id);
  }

  // Weekly 1:1s between each manager and report.
  for (const person of people) {
    const manager = person.managerKey === null ? undefined : directory.byKey.get(person.managerKey);
    if (manager === undefined || manager.status !== "active") continue;
    const weekday = 1 + (person.index % 5);
    plans.push({
      organizer: manager,
      title: `${manager.givenName} / ${person.givenName} 1:1`,
      description: "Weekly check-in. Agenda lives in the shared 1:1 doc.",
      startsAt: local(
        runtime,
        weekdayBefore(runtime, Math.min(person.tenureDays, history) - 7, weekday),
        `${String(10 + (person.index % 6)).padStart(2, "0")}:30`,
      ),
      minutes: 30,
      rrule: `FREQ=WEEKLY;BYDAY=${WEEKDAYS[weekday - 1] ?? "MO"}`,
      attendees: [person],
      meet: true,
      rsvp: "mostly-yes",
    });
  }
  // Daily standups per engineering team and weekly department meetings.
  for (const team of ["Platform", "Routing", "Mobile", "Data"]) {
    const members = people.filter(
      (person) => person.department === "engineering" && person.team === team,
    );
    const organizer = members[0];
    if (organizer === undefined) continue;
    plans.push({
      organizer,
      title: `${team} standup`,
      startsAt: local(runtime, weekdayBefore(runtime, history - 30, 1), "09:45"),
      minutes: 15,
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      attendees: members.slice(1),
      meet: true,
      rsvp: "mostly-yes",
    });
  }
  for (const department of DEPARTMENTS) {
    const organizer = lead(department.key);
    if (organizer === undefined) continue;
    const members = people.filter(
      (person) => person.department === department.key && person !== organizer,
    );
    if (members.length === 0) continue;
    plans.push({
      organizer,
      title: `${department.name} weekly`,
      description: "Wins, priorities for the week, blockers. Notes in the team drive.",
      startsAt: local(runtime, weekdayBefore(runtime, history - 20, 2), "14:00"),
      minutes: 45,
      rrule: "FREQ=WEEKLY;BYDAY=TU",
      attendees: members,
      meet: true,
      calendar: `team-${department.key}`,
      rsvp: "mostly-yes",
    });
    plans.push({
      organizer,
      title: `${department.name} team social`,
      location: "Providence office kitchen",
      startsAt: local(runtime, weekdayBefore(runtime, history - 25, 5), "16:00"),
      minutes: 60,
      rrule: "FREQ=MONTHLY;BYDAY=2FR",
      attendees: [],
      meet: false,
      calendar: `team-${department.key}`,
      rsvp: "fresh",
    });
  }
  plans.push({
    organizer: ceo,
    title: "Company all-hands",
    description: "Monthly update from the leadership team, followed by open Q&A.",
    location: "Providence office — Lighthouse room",
    startsAt: local(runtime, weekdayBefore(runtime, history - 15, 4), "16:00"),
    minutes: 60,
    rrule: "FREQ=MONTHLY;BYDAY=1TH",
    attendees: people.filter((person) => person !== ceo),
    meet: true,
    rsvp: "mixed",
  });
  if (engineeringLead !== undefined) {
    plans.push({
      organizer: engineeringLead,
      title: "Sprint planning",
      startsAt: local(runtime, weekdayBefore(runtime, history - 40, 1), "13:00"),
      minutes: 60,
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
      attendees: people
        .filter((person) => person.department === "engineering" || person.department === "product")
        .filter((person) => person !== engineeringLead),
      meet: true,
      calendar: "team-engineering",
      rsvp: "mostly-yes",
    });
  }
  const bookClub = people.filter((person) => person.index % 6 === 1);
  if (bookClub.length > 1) {
    plans.push({
      organizer: bookClub[0] as Person,
      title: `Book club: ${random.pick(BOOKS)}`,
      location: "Kitchen, Providence office",
      startsAt: local(runtime, weekdayBefore(runtime, history - 60, 4), "12:30"),
      minutes: 60,
      rrule: "FREQ=MONTHLY;BYDAY=-1TH",
      attendees: bookClub.slice(1),
      meet: false,
      rsvp: "mixed",
    });
  }
  const series = plans.length;

  // Company holidays on the shared holiday calendar, a weekly on-call rotation, and
  // personal out-of-office and focus blocks.
  if (engineeringLead !== undefined && onCall.length > 0) {
    for (let week = -12; week <= 8; week += 1) {
      const monday = new Date(runtime.timeline.now.getTime() + week * 7 * TIME.DAY);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      monday.setUTCHours(0, 0, 0, 0);
      const engineer = onCall[(week + 12) % onCall.length] as Person;
      plans.push({
        organizer: engineeringLead,
        title: `On-call: ${engineer.displayName}`,
        description: "Primary pager for the week. Handover happens Monday morning.",
        startsAt: monday,
        minutes: 7 * 24 * 60,
        allDay: true,
        attendees: [engineer],
        meet: false,
        calendar: "on-call",
        metadata: { transparency: "transparent" },
        rsvp: "fresh",
      });
    }
  }
  for (const [offset, name] of [
    [-320, "Company holiday: Thanksgiving"],
    [-290, "Winter break"],
    [-140, "Company holiday: Memorial Day"],
    [-95, "Company holiday: Independence Day"],
    [24, "Company holiday: Labor Day"],
  ] as const) {
    const day = new Date(runtime.timeline.now.getTime() + offset * TIME.DAY);
    day.setUTCHours(0, 0, 0, 0);
    plans.push({
      organizer: peopleLead,
      title: name,
      startsAt: day,
      minutes: name === "Winter break" ? 7 * 24 * 60 : 24 * 60,
      allDay: true,
      attendees: [],
      meet: false,
      calendar: "holidays",
      metadata: { eventType: "holiday", transparency: "transparent" },
      rsvp: "fresh",
    });
  }
  for (const person of random.sample(people, Math.ceil(people.length / 5))) {
    const start = new Date(runtime.timeline.now.getTime() + random.int(-60, 45) * TIME.DAY);
    start.setUTCHours(0, 0, 0, 0);
    plans.push({
      organizer: person,
      title: random.pick(["Out of office", "Vacation", "Parental leave", "Conference travel"]),
      startsAt: start,
      minutes: random.int(1, 6) * 24 * 60,
      allDay: true,
      attendees: [],
      meet: false,
      metadata: { eventType: "out_of_office", visibility: "public" },
      rsvp: "fresh",
    });
  }

  // One-off meetings: customer calls, reviews, interviews and lunches — past, today and ahead.
  const perPerson = runtime.preset.oneOffEventsPerPerson;
  for (const person of people) {
    const personRandom = SeedRandom.stream("calendar-person", person.key);
    const team = people.filter(
      (other) => other.department === person.department && other !== person,
    );
    for (let index = 0; index < perPerson; index += 1) {
      const daysFromNow = personRandom.weighted<number>([
        [personRandom.int(-170, -1), 6],
        [0, 1],
        [personRandom.int(1, 28), 3],
      ]);
      const startsAt = local(
        runtime,
        daysFromNow,
        `${String(personRandom.int(9, 16)).padStart(2, "0")}:${personRandom.pick(["00", "30"])}`,
      );
      plans.push(oneOff(person, team, people, startsAt, personRandom));
    }
  }
  // The two sign-in accounts always have a realistic "today".
  for (const login of people.filter((person) => person.login !== null)) {
    const team = people.filter((other) => other.department === login.department && other !== login);
    for (const [time, title] of [
      ["10:00", "Roadmap review"],
      ["13:30", `Customer call: ${random.pick(CUSTOMERS).name}`],
      ["15:30", "Hiring sync"],
    ] as const) {
      plans.push({
        organizer: login,
        title,
        startsAt: local(runtime, 0, time),
        minutes: 30,
        attendees: random.sample(team, 3),
        ...(title.startsWith("Customer")
          ? { external: [externalAddress(random.pick(CUSTOMERS))] }
          : {}),
        meet: true,
        rsvp: "mixed",
      });
    }
  }

  let withMeet = 0;
  let pastMeetings = 0;
  let todaysMeetings = 0;
  const created = await mapLimit(plans, 6, async (plan) => {
    const endsAt = new Date(plan.startsAt.getTime() + plan.minutes * TIME.MINUTE);
    const attendees: CalendarAttendeeInput[] = [
      ...plan.attendees.map((person) => ({
        actorId: person.actorId,
        email: person.email,
        displayName: person.displayName,
      })),
      ...(plan.external ?? []).map((guest) => ({ email: guest.address, displayName: guest.name })),
    ];
    let metadata: JsonObject = { ...(plan.metadata ?? {}) };
    if (plan.meet) {
      const room = await conference.createRoom({
        orgId: runtime.orgId,
        actorId: plan.organizer.actorId,
        subject: plan.title,
        startsAt: plan.startsAt,
        endsAt,
        participantActorIds: plan.attendees.map((person) => person.actorId),
      });
      metadata = { ...metadata, conference: { provider: "meet", ...room } };
    }
    const event = await runtime.calendar.createEvent({
      orgId: runtime.orgId,
      actorId: plan.organizer.actorId,
      ...(plan.calendar === undefined ? {} : { calendarId: sharedIds.get(plan.calendar) ?? null }),
      uid: `${seedUuid("event", plan.organizer.key, plan.title, plan.startsAt.toISOString())}@${COMPANY.domain}`,
      title: plan.title,
      ...(plan.description === undefined ? {} : { description: plan.description }),
      ...(plan.location === undefined ? {} : { location: plan.location }),
      startsAt: plan.startsAt,
      endsAt,
      timezone: COMPANY.timezone,
      allDay: plan.allDay ?? false,
      ...(plan.rrule === undefined ? {} : { recurrenceRule: plan.rrule }),
      attendees,
      metadata,
    });
    const createdAt = new Date(
      Math.min(
        plan.startsAt.getTime() - random.int(2, 20) * TIME.DAY,
        runtime.timeline.now.getTime() - TIME.HOUR,
      ),
    );
    runtime.chronology.at(
      "cal_events",
      { id: event.id },
      { created_at: createdAt, updated_at: createdAt },
    );
    const roomId = (metadata.conference as { roomId?: string } | undefined)?.roomId;
    if (roomId !== undefined) {
      runtime.chronology.at(
        "meet_rooms",
        { id: roomId },
        { created_at: createdAt, updated_at: createdAt },
      );
    }
    for (const person of plan.attendees) {
      const status = rsvp(plan, random, plan.startsAt < runtime.timeline.now);
      if (status === "needs_action") continue;
      await runtime.calendar.respondToEvent({
        orgId: runtime.orgId,
        actorId: person.actorId,
        eventId: event.id,
        responseStatus: status,
      });
    }
    return { plan, event, room: metadata.conference as { roomId?: string } | undefined };
  });
  const calendarIds = new Map(
    created
      .filter(({ plan }) => plan.calendar === undefined)
      .map(({ plan, event }) => [plan.organizer.actorId, event.calendarId]),
  );
  for (const entry of created) {
    if (entry.room?.roomId === undefined) continue;
    withMeet += 1;
    const startsAt = entry.plan.startsAt;
    if (
      entry.plan.rrule === undefined &&
      startsAt < runtime.timeline.now &&
      pastMeetings < runtime.preset.pastMeetings
    ) {
      await holdMeeting(runtime, entry.room.roomId, entry.plan, random);
      pastMeetings += 1;
    } else if (
      entry.plan.rrule === undefined &&
      startsAt.toISOString().slice(0, 10) === runtime.timeline.now.toISOString().slice(0, 10)
    ) {
      todaysMeetings += 1;
    }
  }
  const sharedCalendars = await shareCalendars(
    runtime,
    people,
    calendarIds,
    calendarDefs,
    sharedIds,
    ceo,
  );
  await workingHoursProfiles(runtime, people);
  return { series, events: plans.length, withMeet, pastMeetings, todaysMeetings, sharedCalendars };
}

function oneOff(
  person: Person,
  team: readonly Person[],
  people: readonly Person[],
  startsAt: Date,
  random: SeedRandom,
): EventPlan {
  const kind = random.weighted<string>([
    [person.department === "sales" || person.department === "support" ? "customer" : "review", 4],
    ["review", 3],
    ["interview", person.department === "people" || person.managerKey === "person-0" ? 3 : 1],
    ["lunch", 1],
    ["focus", 2],
  ]);
  const customer = random.pick(CUSTOMERS);
  switch (kind) {
    case "customer":
      return {
        organizer: person,
        title: `${customer.name} — ${random.pick(["quarterly review", "onboarding check-in", "renewal discussion", "technical deep dive"])}`,
        description: `Agenda:\n1. Recap of open items\n2. ${random.pick(FEATURES)} questions\n3. Next steps`,
        startsAt,
        minutes: random.pick([30, 45, 60]),
        attendees: random.sample(team, random.int(1, 2)),
        external: [
          externalAddress(customer, 0),
          ...(random.chance(0.4) ? [externalAddress(customer, 1)] : []),
        ],
        meet: true,
        rsvp: "mixed",
      };
    case "interview":
      return {
        organizer: person,
        title: `Interview: ${random.pick(["Senior Software Engineer", "Support Specialist", "Account Executive", "Product Designer"])} candidate`,
        description:
          "Scorecard link in the Recruiting folder. Please submit feedback the same day.",
        startsAt,
        minutes: 45,
        attendees: random.sample(
          people.filter((other) => other !== person),
          2,
        ),
        meet: true,
        rsvp: "mostly-yes",
      };
    case "lunch":
      return {
        organizer: person,
        title: random.pick([
          "Team lunch",
          "Lunch & learn: route optimisation 101",
          "Welcome lunch",
        ]),
        location: "Providence office kitchen",
        startsAt,
        minutes: 60,
        attendees: random.sample(team, Math.min(team.length, random.int(3, 8))),
        meet: false,
        rsvp: "mixed",
      };
    case "focus":
      return {
        organizer: person,
        title: "Focus time",
        startsAt,
        minutes: 120,
        attendees: [],
        meet: false,
        metadata: { eventType: "focus" },
        rsvp: "fresh",
      };
    default:
      return {
        organizer: person,
        title: `${random.pick(["Design review", "Spec review", "Retro", "Planning", "Pricing review", "Incident review"])}: ${random.pick(FEATURES)}`,
        startsAt,
        minutes: random.pick([30, 45, 60]),
        attendees: random.sample(team, Math.min(team.length, random.int(2, 6))),
        meet: random.chance(0.8),
        rsvp: "mixed",
      };
  }
}

function rsvp(plan: EventPlan, random: SeedRandom, past: boolean): CalendarResponseStatus {
  if (plan.rsvp === "fresh") return "needs_action";
  if (plan.rsvp === "mostly-yes") return random.chance(0.92) ? "accepted" : "tentative";
  return random.weighted<CalendarResponseStatus>([
    ["accepted", past ? 7 : 5],
    ["tentative", 1],
    ["declined", 1],
    ["needs_action", past ? 1 : 3],
  ]);
}

/** Replays the Jitsi media events of a meeting that already happened. */
async function holdMeeting(
  runtime: DemoRuntime,
  roomId: string,
  plan: EventPlan,
  random: SeedRandom,
): Promise<void> {
  const start = new Date(plan.startsAt.getTime() + random.int(0, 3) * TIME.MINUTE);
  const end = new Date(plan.startsAt.getTime() + (plan.minutes - random.int(0, 8)) * TIME.MINUTE);
  const event = (name: string, occurredAt: Date, participant?: Person) =>
    runtime.meet.applyMediaEvent({
      eventId: seedUuid("meet-event", roomId, name, participant?.key ?? "room"),
      orgId: runtime.orgId,
      roomId,
      event: name as "conference.started",
      ...(participant === undefined
        ? {}
        : {
            sessionId: seedUuid("meet-session", roomId, participant.key),
            participantId: participant.actorId,
          }),
      occurredAt,
    });
  await event("conference.started", start);
  for (const person of [plan.organizer, ...plan.attendees.filter(() => random.chance(0.85))]) {
    await event(
      "participant.joined",
      new Date(start.getTime() + random.int(0, 4) * TIME.MINUTE),
      person,
    );
    await event(
      "participant.left",
      new Date(end.getTime() - random.int(0, 5) * TIME.MINUTE),
      person,
    );
  }
  await event("conference.ended", end);
}

/**
 * Shared calendars go to their members; people also follow their manager's own
 * calendar, and the Chief of Staff can edit the CEO's.
 */
async function shareCalendars(
  runtime: DemoRuntime,
  people: readonly Person[],
  calendarIds: ReadonlyMap<string, string>,
  sharedCalendars: readonly SharedCalendar[],
  sharedIds: ReadonlyMap<string, string>,
  ceo: Person,
): Promise<number> {
  let shared = 0;
  for (const calendar of sharedCalendars) {
    const calendarId = sharedIds.get(calendar.key) as string;
    for (const member of calendar.members) {
      await runtime.calendar.setCalendarMembership({
        orgId: runtime.orgId,
        actorId: calendar.owner.actorId,
        calendarId,
        memberActorId: member.actorId,
        role: calendar.role,
      });
      shared += 1;
    }
  }
  const share = async (owner: Person, member: Person, role: "reader" | "writer") => {
    const calendarId = calendarIds.get(owner.actorId);
    if (calendarId === undefined || owner === member) return;
    await runtime.calendar.setCalendarMembership({
      orgId: runtime.orgId,
      actorId: owner.actorId,
      calendarId,
      memberActorId: member.actorId,
      role,
    });
    shared += 1;
  };
  for (const person of people) {
    const manager = people.find((other) => other.key === person.managerKey);
    if (manager !== undefined && manager !== ceo) await share(manager, person, "reader");
  }
  const chiefOfStaff = people.find((person) => person.jobTitle === "Chief of Staff");
  if (chiefOfStaff !== undefined) await share(ceo, chiefOfStaff, "writer");
  return shared;
}

async function workingHoursProfiles(
  runtime: DemoRuntime,
  people: readonly Person[],
): Promise<void> {
  const scheduling = new PostgresCalendarSchedulingStore(runtime.sql, runtime.calendar);
  for (const person of people) {
    const remote = person.location.startsWith("Remote");
    await runtime.tenant(
      () =>
        scheduling.setProfile({
          orgId: runtime.orgId,
          actorId: person.actorId,
          timezone: person.location.includes("Lisbon") ? "Europe/Lisbon" : COMPANY.timezone,
          workDays: person.index % 11 === 4 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5],
          workStart: person.index % 3 === 0 ? "08:30" : "09:00",
          workEnd: person.index % 3 === 0 ? "16:30" : "17:30",
          workLocation: remote ? "Home" : person.location,
          externalAvailability: "busy",
        }),
      person.actorId,
    );
  }
}
