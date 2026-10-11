import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { MailThreadNotFoundError } from "./errors.js";
import { parseMailSearchQuery, PostgresMailStore } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

describe("Postgres mail mailbox authorization", () => {
  it("parses Gmail-style operators, quoted phrases and relative dates", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    expect(
      parseMailSearchQuery(
        'road "launch plan" from:"Mira Okafor" to:me cc:ops subject:Q4 label:Urgent ' +
          "has:attachment is:unread is:starred in:sent category:social filename:pdf " +
          "before:2026/10/01 newer_than:2d",
        now,
      ),
    ).toEqual({
      terms: ["launch plan", "road"],
      from: ["Mira Okafor"],
      to: ["me", "ops"],
      subject: ["Q4"],
      filenames: ["pdf"],
      labels: ["urgent"],
      hasAttachment: true,
      unread: true,
      starred: true,
      scope: "sent",
      category: "social",
      before: new Date("2026-10-01T00:00:00.000Z"),
      after: new Date("2026-10-09T12:00:00.000Z"),
    });
    expect(parseMailSearchQuery("has:calendar in:nowhere older_than:1m launch", now)).toEqual({
      terms: ["has:calendar", "in:nowhere", "launch"],
      from: [],
      to: [],
      subject: [],
      filenames: [],
      labels: [],
      before: new Date("2026-09-11T12:00:00.000Z"),
    });
    expect(parseMailSearchQuery("before:2026/02/30").terms).toEqual(["before:2026/02/30"]);
  });

  it("applies parsed operators inside bounded SQL across the selected folder", async () => {
    const recording = recordingSql([]);
    const store = new PostgresMailStore(recording.sql);

    await store.listThreads({
      orgId,
      actorId,
      folder: "all",
      query: "from:mira label:urgent has:attachment is:unread roadmap",
    });

    const text = recording.calls.join("\n");
    expect(text).toContain("metadata->'from'->>'address'");
    expect(text).toContain("message_attachments any_attachment");
    expect(text).toContain("from mail_labels named");
    expect(text).toContain("when 'all' then deleted_at is null and spam_at is null");
    expect(text).toContain("jsonb_build_object('name', sender.name");
    expect(recording.values.flat()).toEqual(
      expect.arrayContaining(["all", "%mira%", "%roadmap%", "urgent", true]),
    );
  });

  it("requires the actor's mailbox state row to read a known thread", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresMailStore(recording.sql);

    await expect(store.getThread({ orgId, actorId, threadId })).resolves.toBeNull();
    expect(recording.calls[0]).toContain("join mail_thread_state mts");
    expect(recording.calls[0]).toContain("mts.actor_id");
    expect(recording.calls[0]).toContain("mts.org_id");
    expect(recording.calls[0]).not.toContain("coalesce(mts.deleted_at");
  });

  it("cannot create mailbox state for an inaccessible known thread id", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.updateThreadState({ orgId, actorId, threadId, patch: { starred: true } }),
    ).rejects.toBeInstanceOf(MailThreadNotFoundError);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]).not.toContain("insert into mail_thread_state");
  });

  it("uses explicit tri-state updates so null restores archived, trashed, and snoozed mail", async () => {
    const recording = recordingSql([[{ labels: [] }], []]);
    const store = new PostgresMailStore(recording.sql);

    await store.updateThreadState({
      orgId,
      actorId,
      threadId,
      patch: { archivedAt: null, deletedAt: null, snoozedUntil: null },
    });

    expect(recording.calls[1]).toContain("archived_at = case");
    expect(recording.calls[1]).toContain("deleted_at = case");
    expect(recording.calls[1]).toContain("snoozed_until = case");
    expect(recording.calls[1]).not.toContain("archived_at = coalesce");
  });

  it("scopes search projections by organization and mailbox actor", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresMailStore(recording.sql);

    await expect(store.getMailSearchRecord({ orgId, actorId, messageId })).resolves.toBeNull();
    expect(recording.calls[0]).toContain("mailbox.actor_id");
    expect(recording.calls[0]).toContain("mailbox.org_id");
  });
});
function recordingSql(responses: readonly unknown[]) {
  const recording = sharedRecordingSql(responses, "$");
  return {
    sql: recording.sql,
    get calls() {
      return recording.queries;
    },
    get values() {
      return recording.values;
    },
  };
}
