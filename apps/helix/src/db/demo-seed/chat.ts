import type { ChatSpaceType } from "../../platform/chat/types.js";
import { activePeople, DEPARTMENTS, type Person } from "./company.js";
import { mapLimit } from "./concurrency.js";
import type { Directory } from "./directory.js";
import { barChartPng, csv } from "./files.js";
import { chatLine, directLine, REACTIONS, type SpaceTone } from "./chat-content.js";
import { SeedRandom, TIME } from "./random.js";
import type { DemoRuntime } from "./runtime.js";

export interface ChatSeed {
  readonly spaces: number;
  readonly directMessages: number;
  readonly groupMessages: number;
  readonly messages: number;
  readonly threadReplies: number;
  readonly reactions: number;
  readonly pins: number;
  readonly edited: number;
  readonly deleted: number;
  readonly attachments: number;
}

interface SpacePlan {
  readonly key: string;
  readonly name: string;
  readonly topic: string;
  readonly owner: Person;
  readonly members: readonly Person[];
  readonly tone: SpaceTone;
  readonly spaceType: Exclude<ChatSpaceType, "direct">;
  readonly kind: "chat_room" | "chat_dm";
  readonly messages: number;
  /** How far back the conversation goes, in days. */
  readonly spanDays: number;
}

interface Posted {
  readonly id: string;
  readonly at: Date;
  readonly author: Person;
  readonly reply: boolean;
}

const RECENT_NOTIFY_MS = 2 * TIME.DAY;

/**
 * Chat spaces per team plus company and social spaces, direct and group
 * messages: months of history with threads, mentions, reactions, pins, edits,
 * deletions and attachments, and per-person read positions.
 */
export async function seedChat(runtime: DemoRuntime, directory: Directory): Promise<ChatSeed> {
  const people = activePeople(directory.people);
  const plans = spacePlans(runtime, directory, people);
  const totals = {
    messages: 0,
    threadReplies: 0,
    reactions: 0,
    pins: 0,
    edited: 0,
    deleted: 0,
    attachments: 0,
  };
  // Chat only accepts attachments on storage with encryption at rest, like the API.
  const encrypted =
    (await runtime.storageResolver({ orgId: runtime.orgId }))?.encryptionAtRest !== undefined;
  if (!encrypted) {
    runtime.log(
      "chat",
      "object storage has no server-side encryption configured; chat attachments are skipped",
    );
  }
  await mapLimit(plans, 8, async (plan) => {
    const random = SeedRandom.stream("chat", plan.key);
    const room = await runtime.chat.createRoom({
      orgId: runtime.orgId,
      actorId: plan.owner.actorId,
      kind: plan.kind,
      ...(plan.kind === "chat_room"
        ? {
            subject: plan.name,
            topic: plan.topic,
            privacy:
              plan.tone === "general" || plan.tone === "social" ? "discoverable" : "restricted",
            spaceType: plan.spaceType,
          }
        : {}),
      memberActorIds: plan.members.map((person) => person.actorId),
    });
    const opened = new Date(runtime.timeline.now.getTime() - (plan.spanDays + 3) * TIME.DAY);
    runtime.chronology.at("threads", { id: room.id }, { created_at: opened, updated_at: opened });
    runtime.chronology.at(
      "chat_room_settings",
      { thread_id: room.id },
      { created_at: opened, updated_at: opened },
    );
    const posters =
      plan.spaceType === "announcement" ? [plan.owner] : [plan.owner, ...plan.members];
    const times = Array.from({ length: plan.messages }, () =>
      runtime.timeline.recentWorkday(random, plan.spanDays),
    ).sort((left, right) => left.getTime() - right.getTime());
    const posted: Posted[] = [];
    for (const at of times) {
      const author = random.pick(posters);
      const replyTo =
        posted.length > 3 && random.chance(0.12)
          ? random.pick(
              posted
                .slice(-12)
                .filter((entry) => !entry.reply)
                .concat(posted[0] as Posted),
            )
          : undefined;
      const others = [plan.owner, ...plan.members].filter((person) => person !== author);
      const mention =
        plan.kind === "chat_room" && others.length > 0 && random.chance(0.18)
          ? random.pick(others)
          : null;
      const body =
        plan.kind === "chat_dm"
          ? directLine(random, random.pick(others.length > 0 ? others : [plan.owner]))
          : chatLine(plan.tone, random, mention);
      const attachment =
        encrypted && plan.kind === "chat_room" && random.chance(0.02)
          ? await runtime.chatAttachments.upload({
              orgId: runtime.orgId,
              actorId: author.actorId,
              roomId: room.id,
              ...(random.chance(0.5)
                ? {
                    filename: "chart.png",
                    declaredMimeType: "image/png",
                    bytes: barChartPng([4, 7, 5, 9, 12, 10], `${plan.key}${String(posted.length)}`),
                  }
                : {
                    filename: "numbers.csv",
                    declaredMimeType: "text/csv",
                    bytes: csv([
                      ["metric", "value"],
                      ["tickets", random.int(40, 200)],
                      ["csat", random.int(85, 99)],
                    ]),
                  }),
            })
          : undefined;
      const message = await runtime.chat.sendMessage({
        orgId: runtime.orgId,
        actorId: author.actorId,
        roomId: room.id,
        body,
        ...(replyTo === undefined ? {} : { parentMessageId: replyTo.id }),
        ...(attachment === undefined ? {} : { attachmentObjectIds: [attachment.objectId] }),
        suppressNotifications: runtime.timeline.now.getTime() - at.getTime() > RECENT_NOTIFY_MS,
      });
      if (attachment !== undefined) totals.attachments += 1;
      if (replyTo !== undefined) totals.threadReplies += 1;
      posted.push({ id: message.id, at, author, reply: replyTo !== undefined });
      runtime.chronology.at("messages", { id: message.id }, { created_at: at, sent_at: at });
    }
    totals.messages += posted.length;
    await decorate(runtime, plan, room.id, posted, random, totals);
  });
  const dms = plans.filter((plan) => plan.kind === "chat_dm");
  return {
    spaces: plans.length - dms.length,
    directMessages: dms.filter((plan) => plan.members.length === 1).length,
    groupMessages: dms.filter((plan) => plan.members.length > 1).length,
    ...totals,
  };
}

/** Reactions, edits, deletions, pins and each member's read position. */
async function decorate(
  runtime: DemoRuntime,
  plan: SpacePlan,
  roomId: string,
  posted: readonly Posted[],
  random: SeedRandom,
  totals: { reactions: number; pins: number; edited: number; deleted: number },
): Promise<void> {
  const everyone = [plan.owner, ...plan.members];
  const deleted = new Set<string>();
  for (const message of posted) {
    if (random.chance(plan.kind === "chat_dm" ? 0.08 : 0.22)) {
      for (const reactor of random.sample(
        everyone.filter((person) => person !== message.author),
        random.int(1, 4),
      )) {
        await runtime.chat.react({
          orgId: runtime.orgId,
          actorId: reactor.actorId,
          messageId: message.id,
          emoji: random.pick(REACTIONS),
          op: "add",
        });
        totals.reactions += 1;
      }
    }
    if (random.chance(0.03)) {
      await runtime.chat.editMessage({
        orgId: runtime.orgId,
        actorId: message.author.actorId,
        messageId: message.id,
        body: `${chatLine(plan.tone, random, null)} (edited for clarity)`,
      });
      totals.edited += 1;
      runtime.chronology.at(
        "messages",
        { id: message.id },
        {
          created_at: message.at,
          sent_at: message.at,
          edited_at: new Date(message.at.getTime() + random.int(1, 30) * TIME.MINUTE),
        },
      );
    } else if (random.chance(0.01)) {
      await runtime.chat.deleteMessage({
        orgId: runtime.orgId,
        actorId: message.author.actorId,
        messageId: message.id,
      });
      deleted.add(message.id);
      totals.deleted += 1;
      runtime.chronology.at(
        "messages",
        { id: message.id },
        {
          created_at: message.at,
          sent_at: message.at,
          deleted_at: new Date(message.at.getTime() + random.int(1, 10) * TIME.MINUTE),
        },
      );
    }
  }
  const visible = posted.filter((message) => !deleted.has(message.id) && !message.reply);
  if (plan.kind === "chat_room" && visible.length > 10) {
    for (const message of random.sample(visible, random.int(1, 3))) {
      await runtime.chat.pinMessage({
        orgId: runtime.orgId,
        actorId: plan.owner.actorId,
        roomId,
        messageId: message.id,
      });
      totals.pins += 1;
      runtime.chronology.at(
        "chat_pins",
        { message_id: message.id },
        { created_at: new Date(message.at.getTime() + TIME.HOUR) },
      );
    }
  }
  const last = visible.at(-1);
  if (last === undefined) return;
  for (const member of everyone) {
    // Most people are caught up; some lag behind, and the sign-in accounts keep a few unread.
    const lag =
      member.login !== null && random.chance(0.4)
        ? random.int(1, 6)
        : random.chance(0.25)
          ? random.int(1, 25)
          : 0;
    const read = visible[Math.max(0, visible.length - 1 - lag)] ?? last;
    await runtime.chat.markRead({
      orgId: runtime.orgId,
      actorId: member.actorId,
      roomId,
      messageId: read.id,
    });
    runtime.chronology.at(
      "chat_read_receipts",
      { thread_id: roomId, actor_id: member.actorId },
      {
        last_read_at: new Date(read.at.getTime() + random.int(1, 90) * TIME.MINUTE),
        updated_at: new Date(read.at.getTime() + random.int(1, 90) * TIME.MINUTE),
      },
    );
  }
}

function spacePlans(
  runtime: DemoRuntime,
  directory: Directory,
  people: readonly Person[],
): SpacePlan[] {
  const random = SeedRandom.stream("chat-spaces");
  const ceo = directory.byKey.get("person-0") as Person;
  const lead = (key: string) =>
    people.find((person) => person.department === key && person.managerKey === "person-0");
  const per = runtime.preset.chatMessagesPerSpace;
  const span = Math.min(runtime.timeline.historyDays, 420);
  const space = (
    key: string,
    name: string,
    topic: string,
    owner: Person | undefined,
    members: readonly Person[],
    tone: SpaceTone,
    scale: number,
    spaceType: SpacePlan["spaceType"] = "conversation",
  ): SpacePlan[] =>
    owner === undefined || members.length === 0
      ? []
      : [
          {
            key,
            name,
            topic,
            owner,
            members: members.filter((person) => person !== owner),
            tone,
            spaceType,
            kind: "chat_room",
            messages: Math.max(8, Math.round(per * scale)),
            spanDays: span,
          },
        ];
  const plans: SpacePlan[] = [
    ...space("general", "General", "Company-wide chatter. Be kind.", ceo, people, "general", 1.2),
    ...space(
      "announcements",
      "Announcements",
      "Official updates from the leadership team.",
      ceo,
      people,
      "general",
      0.15,
      "announcement",
    ),
    ...space("random", "Random", "Pets, lunch, weekend plans.", people[3], people, "social", 0.8),
    ...space(
      "it-help",
      "IT Help",
      "Ask the IT team anything. Response within a business day.",
      lead("operations"),
      people,
      "it",
      0.5,
    ),
    ...space(
      "incidents",
      "Incidents",
      "Live incident coordination. Postmortems in the Engineering drive.",
      lead("engineering"),
      people.filter(
        (person) => person.department === "engineering" || person.department === "support",
      ),
      "incident",
      0.5,
      "project",
    ),
    ...space(
      "launch",
      "Waypoint 5 launch",
      "Launch coordination: product, design, marketing and engineering leads.",
      lead("product"),
      people.filter(
        (person) =>
          ["product", "design", "marketing"].includes(person.department) ||
          person.managerKey === "person-0",
      ),
      "launch",
      0.6,
      "project",
    ),
    ...space(
      "book-club",
      "Book club",
      "One book a month.",
      people.find((person) => person.index % 6 === 1),
      people.filter((person) => person.index % 6 === 1),
      "social",
      0.25,
    ),
    ...space(
      "running",
      "Running club",
      "Tuesday and Saturday runs.",
      people.find((person) => person.index % 7 === 3),
      people.filter((person) => person.index % 7 === 3),
      "social",
      0.2,
    ),
  ];
  for (const department of DEPARTMENTS) {
    const members = people.filter((person) => person.department === department.key);
    plans.push(
      ...space(
        `dept-${department.key}`,
        department.name,
        `${department.name} team space.`,
        lead(department.key) ?? members[0],
        members,
        department.key === "engineering" ? "engineering" : "team",
        1,
      ),
    );
  }
  for (const team of ["Platform", "Routing", "Mobile", "Data"]) {
    const members = people.filter(
      (person) => person.department === "engineering" && person.team === team,
    );
    plans.push(
      ...space(
        `eng-${team.toLowerCase()}`,
        `Eng · ${team}`,
        `${team} team: standup notes, reviews, deploys.`,
        members[0],
        members,
        "engineering",
        0.9,
      ),
    );
  }
  // Direct messages with close teammates, plus a few small group conversations.
  const pairs = new Set<string>();
  for (const person of people) {
    const partners = random.sample(
      people.filter(
        (other) =>
          other !== person &&
          (other.department === person.department || other.key === person.managerKey),
      ),
      2,
    );
    for (const partner of partners) {
      const key = [person.key, partner.key].sort().join("+");
      if (pairs.has(key)) continue;
      pairs.add(key);
      plans.push({
        key: `dm-${key}`,
        name: "",
        topic: "",
        owner: person,
        members: [partner],
        tone: "team",
        spaceType: "conversation",
        kind: "chat_dm",
        messages: Math.max(
          4,
          Math.round(runtime.preset.directMessagesPerPair * (0.5 + random.next())),
        ),
        spanDays: Math.min(span, Math.min(person.tenureDays, partner.tenureDays)),
      });
    }
  }
  for (let index = 0; index < Math.max(3, Math.round(people.length / 12)); index += 1) {
    const group = random.sample(people, random.int(3, 4));
    const [owner, ...members] = group;
    if (owner === undefined) continue;
    plans.push({
      key: `group-${String(index)}`,
      name: "",
      topic: "",
      owner,
      members,
      tone: "team",
      spaceType: "conversation",
      kind: "chat_dm",
      messages: Math.round(runtime.preset.directMessagesPerPair * 1.5),
      spanDays: 200,
    });
  }
  return plans;
}
