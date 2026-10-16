import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseMailBodyBackfillArgs } from "./backfill-mail-bodies.js";

it("requires an explicit valid tenant for the mail body migration", () => {
  const orgId = randomUUID();
  expect(parseMailBodyBackfillArgs(["--org-id", orgId])).toBe(orgId);
  expect(() => parseMailBodyBackfillArgs([])).toThrow("Usage:");
  expect(() => parseMailBodyBackfillArgs(["--org-id", "all"])).toThrow();
});
