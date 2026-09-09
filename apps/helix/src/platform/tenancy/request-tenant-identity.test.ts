import { describe, expect, it } from "vitest";
import {
  isDefaultOrgOnlyIdentity,
  RequestTenantIdentityError,
  resolveRequestOrgIdentity,
} from "./request-tenant-identity.js";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const TENANT = "00000000-0000-4000-8000-0000000000b2";
const DEFAULT = "00000000-0000-0000-0000-000000000000";

describe("resolveRequestOrgIdentity (G1.8)", () => {
  it("prefers the authenticated actor org", () => {
    expect(
      resolveRequestOrgIdentity({
        actorOrgId: ACTOR,
        resolvedTenantOrgId: undefined,
        defaultOrgId: DEFAULT,
      }),
    ).toBe(ACTOR);
  });

  it("accepts an explicit resolved tenant when no actor is present", () => {
    expect(
      resolveRequestOrgIdentity({
        actorOrgId: undefined,
        resolvedTenantOrgId: TENANT,
        defaultOrgId: DEFAULT,
      }),
    ).toBe(TENANT);
  });

  it("refuses silent fallback to HELIX_DEFAULT_ORG_ID on request paths", () => {
    expect(() =>
      resolveRequestOrgIdentity({
        actorOrgId: undefined,
        resolvedTenantOrgId: undefined,
        defaultOrgId: DEFAULT,
        bootstrapContext: false,
      }),
    ).toThrow(RequestTenantIdentityError);
  });

  it("allows default org only in bootstrap context", () => {
    expect(
      resolveRequestOrgIdentity({
        actorOrgId: undefined,
        resolvedTenantOrgId: undefined,
        defaultOrgId: DEFAULT,
        bootstrapContext: true,
      }),
    ).toBe(DEFAULT);
  });

  it("rejects actor/tenant mismatch", () => {
    expect(() =>
      resolveRequestOrgIdentity({
        actorOrgId: ACTOR,
        resolvedTenantOrgId: TENANT,
        defaultOrgId: DEFAULT,
      }),
    ).toThrow(/does not match/);
  });

  it("detects default-org-only identity candidates", () => {
    expect(
      isDefaultOrgOnlyIdentity({
        actorOrgId: undefined,
        resolvedTenantOrgId: undefined,
        defaultOrgId: DEFAULT,
      }),
    ).toBe(true);
    expect(
      isDefaultOrgOnlyIdentity({
        actorOrgId: ACTOR,
        resolvedTenantOrgId: undefined,
        defaultOrgId: DEFAULT,
      }),
    ).toBe(false);
  });
});
