import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0118_chat_privacy_and_dm_identity.sql", import.meta.url),
  "utf8",
);

describe("0118 chat privacy and direct-message identity", () => {
  it("uses a closed privacy model and one tenant participant key", () => {
    expect(migration).toContain("'discoverable', 'restricted', 'private'");
    expect(migration).toContain("drop column if exists is_private");
    expect(migration).toContain(
      "unique index if not exists chat_room_settings_org_participant_key_idx",
    );
    expect(migration).toContain("where participant_key is not null");
  });
});
