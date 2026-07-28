import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  requireActiveChatAttachments,
  requireChatActorInOrg,
  requireChatActorsInOrg,
  requireChatRoomAccess,
  visibleChatAttachments,
} from "./authorization.js";
import { ChatAttachmentAccessError, ChatMemberAccessError, ChatRoomAccessError } from "./errors.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_ID = "44444444-4444-4444-8444-444444444444";

describe("central Chat authorization", () => {
  it("returns the same non-enumerable denial for missing and cross-org actors", async () => {
    const sql = fakeSql([[]]);
    await expect(requireChatActorInOrg(sql.tag, ORG_ID, ACTOR_ID)).rejects.toMatchObject({
      code: "not_found",
      message: "Chat room was not found.",
      details: undefined,
    });
    expect(sql.calls[0]).toContain("a");
    expect(sql.calls[0]).toContain("org_id");
    expect(sql.calls[0]).toContain("disabled_at is null");
  });

  it("requires an unexpired room permission and active same-org actor", async () => {
    const denied = fakeSql([[]]);
    await expect(
      requireChatRoomAccess(denied.tag, {
        orgId: ORG_ID,
        actorId: ACTOR_ID,
        roomId: ROOM_ID,
      }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    expect(denied.calls[0]).toContain("p.org_id = t.org_id");
    expect(denied.calls[0]).toContain("p.expires_at");
    expect(denied.calls[0]).toContain("a.disabled_at is null");
    expect(denied.calls[0]).not.toContain("created_by_actor_id");
  });

  it("enforces owner/admin administration and takes a membership lock", async () => {
    const member = fakeSql([[{ role: "member" }]]);
    await expect(
      requireChatRoomAccess(member.tag, {
        orgId: ORG_ID,
        actorId: ACTOR_ID,
        roomId: ROOM_ID,
        roles: ["owner", "admin"],
        lock: true,
      }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    expect(member.calls[0]).toContain("for key share of t, p");
  });

  it("rejects a partially matching invite target set without identifying the actor", async () => {
    const sql = fakeSql([[{ id: ACTOR_ID }]]);
    await expect(
      requireChatActorsInOrg(sql.tag, ORG_ID, [ACTOR_ID, ROOM_ID]),
    ).rejects.toBeInstanceOf(ChatMemberAccessError);
  });

  it("rejects missing, inactive, quarantined, deleted, or inaccessible attachments alike", async () => {
    const sql = fakeSql([[]]);
    await expect(
      requireActiveChatAttachments(sql.tag, {
        orgId: ORG_ID,
        actorId: ACTOR_ID,
        objectIds: [OBJECT_ID],
      }),
    ).rejects.toBeInstanceOf(ChatAttachmentAccessError);
    expect(sql.calls[0]).toContain("o.upload_state = 'active'");
    expect(sql.calls[0]).toContain("o.deleted_at is null");
    expect(sql.calls[0]).toContain("p.resource_type = 'object'");
    expect(sql.calls[0]).toContain("p.expires_at");
    expect(sql.calls[0]).toContain("for key share of o");
  });

  it("filters revoked attachments at read time instead of leaking stale IDs", async () => {
    const sql = fakeSql([[{ message_id: ROOM_ID, object_id: OBJECT_ID }]]);
    const visible = await visibleChatAttachments(sql.tag, {
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      messageIds: [ROOM_ID, ACTOR_ID],
    });
    expect(visible.get(ROOM_ID)).toEqual([OBJECT_ID]);
    expect(visible.has(ACTOR_ID)).toBe(false);
    expect(sql.calls[0]).toContain("o.upload_state = 'active'");
  });
});

function fakeSql(responses: readonly unknown[][]): {
  readonly tag: postgres.Sql;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(
      strings.reduce(
        (text, part, partIndex) => `${text}${part}${partIndex < values.length ? "?" : ""}`,
        "",
      ),
    );
    return responses[index++] ?? [];
  }) as unknown as postgres.Sql;
  tag.array = ((values: readonly unknown[]) => values) as unknown as typeof tag.array;
  return { tag, calls };
}
