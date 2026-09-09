import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("mail threading and idempotency migration", () => {
  it("uniquely keys canonical messages and recipient deliveries inside a tenant", async () => {
    const migration = await readFile(
      new URL("./0080_mail_threading_idempotency.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("create table mail_message_identities");
    expect(migration).toContain("(org_id, normalized_message_id)");
    expect(migration).toContain("(org_id, raw_sha256)");
    expect(migration).toContain("(org_id, provider_delivery_id)");
    expect(migration).toContain("create table mail_message_deliveries");
    expect(migration).toContain("primary key (message_id, actor_id)");
    expect(migration).toContain("foreign key (org_id, message_id)");
    expect(migration).toContain("foreign key (org_id, actor_id)");
    expect(migration.match(/enable row level security/gmu)).toHaveLength(2);
  });
});
