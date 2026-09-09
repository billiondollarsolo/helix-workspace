import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0100 Chat ACL revocation events migration", () => {
  it("emits ACL-version events for grants and suspended principals", async () => {
    const sql = await readFile(
      new URL("./0100_chat_acl_revocation_events.sql", import.meta.url),
      "utf8",
    );

    for (const fragment of [
      "set acl_version = settings.acl_version + 1",
      "'type', 'access.changed'",
      "permissions_emit_chat_acl_event",
      "actors_emit_chat_acl_event",
      "organization_memberships_emit_chat_acl_event",
      "identity_subjects_emit_chat_acl_event",
      "membership.status = 'active'",
      "identity.status = 'active'",
    ]) {
      expect(sql).toContain(fragment);
    }
  });
});
