import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { MailThreadNotFoundError } from "./errors.js";
import { parseMailSearchQuery, PostgresMailStore } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

describe("Postgres mail mailbox authorization", () => {
  it("parses only the search operators advertised by the Mail UI", () => {
    expect(
      parseMailSearchQuery('road map from:"Mira Okafor" label:urgent has:attachment label:team'),
    ).toEqual({
      text: "road map",
      from: "Mira Okafor",
      labels: ["urgent", "team"],
      hasAttachment: true,
    });
    expect(parseMailSearchQuery("has:calendar launch")).toEqual({
      text: "has:calendar launch",
      labels: [],
    });
  });

  it("applies parsed sender, label, and attachment filters inside bounded SQL", async () => {
    const recording = recordingSql([[], []]);
    const store = new PostgresMailStore(recording.sql);

    await store.listThreads({
      orgId,
      actorId,
      query: "from:mira label:urgent has:attachment roadmap",
    });

    expect(recording.calls).toHaveLength(2);
    for (const query of recording.calls) {
      expect(query).toContain("metadata->'from'->>'address'");
      expect(query).toContain("has_attachment");
      expect(query).toContain("coalesce(labels");
    }
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
