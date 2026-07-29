import { describe, expect, it } from "vitest";
import { parseReceivingDomainBackfillArgs } from "./backfill-mail-receiving-domain.js";

const orgId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000011";

describe("receiving-domain backfill command", () => {
  it("requires exact identifiers and an explicit ownership attestation", () => {
    expect(() =>
      parseReceivingDomainBackfillArgs([
        "--org-id",
        orgId,
        "--domain",
        "example.com",
        "--created-by",
        actorId,
      ]),
    ).toThrow("ownership-attested");
    expect(() =>
      parseReceivingDomainBackfillArgs([
        "--org-id",
        "not-a-uuid",
        "--domain",
        "example.com",
        "--created-by",
        actorId,
        "--ownership-attested",
      ]),
    ).toThrow("--org-id must be a UUID");
  });

  it("parses one bounded idempotent backfill request", () => {
    expect(
      parseReceivingDomainBackfillArgs([
        "--org-id",
        orgId,
        "--domain",
        "EXAMPLE.com",
        "--created-by",
        actorId,
        "--catch-all-actor-id",
        actorId,
        "--ownership-attested",
      ]),
    ).toEqual({
      orgId,
      domain: "EXAMPLE.com",
      createdBy: actorId,
      catchAllActorId: actorId,
    });
  });

  it("rejects unknown or unbounded arguments", () => {
    expect(() => parseReceivingDomainBackfillArgs(["--all"])).toThrow("Unknown");
    expect(() => parseReceivingDomainBackfillArgs(["--org-id"])).toThrow("Missing value");
  });
});
