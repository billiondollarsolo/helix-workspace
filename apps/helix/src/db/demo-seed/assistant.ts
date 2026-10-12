import type { Actor, JsonObject } from "@helix/sdk-types";
import { activePeople, type Person } from "./company.js";
import type { Directory } from "./directory.js";
import { SeedRandom, seedUuid, TIME } from "./random.js";
import type { DemoRuntime } from "./runtime.js";

export interface AssistantSeed {
  readonly conversations: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly feedback: number;
}

/** The deterministic local model used by end-to-end tests; nothing calls out. */
const FAKE_MODEL = { providerId: "openai-compatible", model: "helix-e2e-model" } as const;

interface Cited {
  readonly kind: "mail" | "drive" | "calendar";
  readonly id: string;
  readonly title: string;
}

/**
 * Past Assistant conversations in the shape the orchestrator saves them: the
 * question, the tool call and its result, and an answer citing the workspace
 * records it used, with the user's feedback. Answers are written as the local
 * fake model's output; no provider is contacted.
 */
export async function seedAssistant(
  runtime: DemoRuntime,
  directory: Directory,
): Promise<AssistantSeed> {
  const people = activePeople(directory.people);
  const users = [
    ...people.filter((person) => person.login !== null),
    ...people.filter((person) => person.login === null && person.index % 9 === 5),
  ].slice(0, Math.max(2, Math.ceil(runtime.preset.assistantConversations / 2)));
  const totals = { conversations: 0, messages: 0, toolCalls: 0, feedback: 0 };
  for (const person of users) {
    const random = SeedRandom.stream("assistant", person.key);
    const actor: Actor = {
      id: person.actorId,
      orgId: runtime.orgId,
      type: "user",
      email: person.email,
    };
    await runtime.assistant.setMemoryPreference({
      actor,
      enabled: true,
      metadata: { source: "settings" },
    });
    const records = await citable(runtime, person);
    const count =
      person.login === null ? 2 : Math.max(3, Math.ceil(runtime.preset.assistantConversations / 2));
    for (let index = 0; index < count; index += 1) {
      const topic = TOPICS[(index + person.index) % TOPICS.length] as Topic;
      const cited = records
        .filter((record) => record.kind === topic.kind)
        .slice(index % 3, (index % 3) + 2);
      const started = runtime.timeline.recentWorkday(random, 120);
      const conversation = await runtime.assistant.createConversation({
        actor,
        title: topic.title,
        memoryOptIn: true,
        metadata: { source: "assistant" },
      });
      let at = started;
      const append = async (
        role: "user" | "assistant" | "tool",
        content: string,
        metadata: JsonObject,
        toolCallId?: string,
      ) => {
        at = new Date(at.getTime() + random.int(2, 40) * 1000);
        const message = await runtime.assistant.appendMessage({
          conversationId: conversation.id,
          orgId: runtime.orgId,
          actorId: role === "user" ? person.actorId : null,
          role,
          content,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          metadata,
          createdAt: at,
        });
        totals.messages += 1;
        return message;
      };
      await append("user", topic.question, {});
      const toolCallId = `call_${seedUuid("tool", person.key, index).slice(0, 12)}`;
      const toolCall = {
        toolCallId,
        toolId: topic.toolId,
        input: topic.input,
        status: "executed",
        output: {
          results: cited.map((record) => ({
            id: record.id,
            title: record.title,
            type: record.kind,
          })),
        },
        sourceIds: cited.map((record) => record.id),
      };
      await append("tool", JSON.stringify(toolCall.output), { toolCall }, toolCallId);
      totals.toolCalls += 1;
      const answer = await append("assistant", topic.answer(cited), {
        ...FAKE_MODEL,
        selectedModelId: FAKE_MODEL.model,
        usage: { promptTokens: random.int(400, 2400), completionTokens: random.int(60, 260) },
        toolCalls: [{ id: toolCallId, name: topic.toolId, arguments: topic.input }],
        toolActivity: [{ toolCallId, toolId: topic.toolId, status: "executed" }],
        citations: cited.map((record) => ({
          kind: record.kind,
          id: record.id,
          title: record.title,
        })),
      });
      runtime.chronology.at(
        "assistant_conversations",
        { id: conversation.id },
        { created_at: started, updated_at: at },
      );
      totals.conversations += 1;
      if (random.chance(0.6)) {
        const rating = random.chance(0.8) ? "up" : "down";
        await runtime.assistantFeedback.setFeedback({
          actor,
          conversationId: conversation.id,
          messageId: answer.id,
          rating,
          comment:
            rating === "down"
              ? "Missed the newest thread."
              : random.chance(0.3)
                ? "Exactly what I needed."
                : null,
        });
        totals.feedback += 1;
        const ratedAt = new Date(at.getTime() + 2 * TIME.MINUTE);
        runtime.chronology.at(
          "assistant_message_feedback",
          { message_id: answer.id },
          { created_at: ratedAt, updated_at: ratedAt },
        );
      }
    }
  }
  return totals;
}

interface Topic {
  readonly title: string;
  readonly question: string;
  readonly kind: Cited["kind"];
  readonly toolId: string;
  readonly input: JsonObject;
  readonly answer: (cited: readonly Cited[]) => string;
}

const list = (cited: readonly Cited[]) =>
  cited.length === 0
    ? "I couldn't find anything matching."
    : cited.map((record) => `- ${record.title}`).join("\n");

const TOPICS: readonly Topic[] = [
  {
    title: "Catch up on customer mail",
    question: "What did customers write to us about this week?",
    kind: "mail",
    toolId: "mail.search",
    input: { query: "newer_than:7d", limit: 10 },
    answer: (cited) =>
      `Here are the customer threads from this week:\n${list(cited)}\n\nThe main theme is questions about routing exports.`,
  },
  {
    title: "Find the latest budget sheet",
    question: "Where is the latest budget spreadsheet?",
    kind: "drive",
    toolId: "drive.search",
    input: { query: "budget" },
    answer: (cited) => `These look like the most recent budget files:\n${list(cited)}`,
  },
  {
    title: "Prepare for tomorrow",
    question: "What's on my calendar tomorrow and what should I prepare?",
    kind: "calendar",
    toolId: "calendar.events.list",
    input: { range: "tomorrow" },
    answer: (cited) =>
      `You have these meetings:\n${list(cited)}\n\nFor the customer call, skim the latest proposal in the Sales drive.`,
  },
  {
    title: "Summarize the escalation",
    question: "Summarize the latest escalation thread for me.",
    kind: "mail",
    toolId: "mail.search",
    input: { query: "escalation", limit: 5 },
    answer: (cited) =>
      `The escalation threads I found:\n${list(cited)}\n\nEngineering acknowledged the issue and a fix is being tested.`,
  },
];

/** A few records the person can open, to cite from saved answers. */
async function citable(runtime: DemoRuntime, person: Person): Promise<readonly Cited[]> {
  return runtime.tenant(async (tx) => {
    const mail = await tx<{ id: string; title: string }[]>`
      select message.id, coalesce(thread.subject, '(no subject)') as title
      from mail_message_deliveries delivery
      join messages message on message.id = delivery.message_id
      join threads thread on thread.id = message.thread_id
      where delivery.actor_id = ${person.actorId}
      order by message.sent_at desc limit 6
    `;
    const drive = await tx<{ id: string; title: string }[]>`
      select id, metadata->>'name' as title from objects
      where kind = 'file' and deleted_at is null and helix_drive_effective_role(org_id, ${person.actorId}, 'object', id) is not null
      order by created_at desc limit 6
    `;
    const calendar = await tx<{ id: string; title: string }[]>`
      select event.id, event.title from cal_attendees attendee join cal_events event on event.id = attendee.event_id
      where attendee.actor_id = ${person.actorId} and event.recurrence_rule is null
      order by event.starts_at desc limit 6
    `;
    return [
      ...mail.map((row) => ({ kind: "mail" as const, ...row })),
      ...drive.map((row) => ({ kind: "drive" as const, ...row })),
      ...calendar.map((row) => ({ kind: "calendar" as const, ...row })),
    ];
  }, person.actorId);
}
