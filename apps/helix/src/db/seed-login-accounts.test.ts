import { expect, it } from "vitest";
import { validatedPermissions } from "../platform/permissions/scope-catalog.js";
import { createRecordingSql } from "../test-support/recording-sql.js";
import { seedLoginAccounts } from "./seed-login-accounts.js";

it("seeds admin and member permissions that survive session validation", async () => {
  const recording = createRecordingSql(({ text, values }) => {
    if (!text.includes("helix_activate_identity_membership")) return [];
    const userId = values.find((value) => typeof value === "string" && value.startsWith("login-"));
    return [{ actor_id: String(userId).slice("login-".length) }];
  });

  const result = await seedLoginAccounts(recording.sql);

  expect(result.accounts).toHaveLength(2);
  for (const scopes of recording.arrays) {
    expect(validatedPermissions(scopes)).toEqual(scopes);
    expect(scopes).toEqual(expect.arrayContaining(["mail.read", "notifications.read"]));
  }
  expect(recording.arrays).toHaveLength(2);
});
