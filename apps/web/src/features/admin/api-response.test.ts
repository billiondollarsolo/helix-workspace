import { describe, expect, it } from "vitest";
import { ensureOk } from "./api-response";

describe("ensureOk", () => {
  it("accepts a completed change", async () => {
    await expect(ensureOk(new Response(null, { status: 204 }), "release")).resolves.toBeUndefined();
  });

  it("refuses a change that is waiting for a second administrator", async () => {
    const parked = Response.json(
      { code: "crown_jewel_approval_required", approval: { id: "req-1" } },
      { status: 202 },
    );
    await expect(ensureOk(parked, "release")).rejects.toThrow(/second administrator/u);
  });
});
