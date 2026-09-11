import type { HelixConfig } from "@helix/sdk-types";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { AuthorizingSearchEngine } from "./authorized.js";
import { SemanticSearchRuntime } from "./semantic-runtime.js";
import type { IndexDocument, SearchEngine } from "./types.js";

const config: HelixConfig = { security: { tier: "personal" } };
const request = { query: "plan", forOrgId: "org", forActorId: "actor" };

describe("current search-source classification", () => {
  it.each(["keyword", "semantic"])(
    "hydrates %s hits after authorization with current content and classification",
    async (searchProvenance) => {
      let classification = "standard" as "standard" | "restricted";
      const current: IndexDocument = {
        id: "drive:file",
        type: "drive",
        body: "Current ordinary plan",
        attributes: { orgId: "org", fileId: "file" },
      };
      const resolveDocument = vi.fn(async () => current);
      const runtime = new SemanticSearchRuntime({
        sql: {} as postgres.Sql,
        getConfig: () => config,
        resolveDocument,
        classifications: {
          get: async () => ({
            orgId: "org",
            resourceType: "drive.file",
            resourceId: "file",
            classification,
            source: "explicit",
            reason: "current policy",
            updatedAt: "2026-09-10T00:00:00Z",
          }),
        },
      });
      const keyword: SearchEngine = {
        id: "index",
        index: async () => {},
        upsert: async () => {},
        delete: async () => {},
        search: async () => ({
          query: "plan",
          hits: [
            {
              ...current,
              body: "Stale plan",
              highlights: { body: "stale snippet" },
              attributes: { ...current.attributes, searchProvenance },
            },
          ],
        }),
      };
      const engine = new AuthorizingSearchEngine({
        engine: keyword,
        authorize: () => true,
        hydrate: (scope, hit) => runtime.classifyHit(scope, hit),
      });
      expect((await engine.search(request)).hits[0]).toMatchObject({
        body: current.body,
        attributes: { classification: "standard", searchProvenance },
      });
      expect((await engine.search(request)).hits[0]?.highlights).toBeUndefined();
      classification = "restricted";
      expect((await engine.search(request)).hits[0]?.attributes?.classification).toBe("restricted");
      resolveDocument.mockClear();
      const denied = new AuthorizingSearchEngine({
        engine: keyword,
        authorize: () => false,
        hydrate: (scope, hit) => runtime.classifyHit(scope, hit),
      });
      expect((await denied.search(request)).hits).toEqual([]);
      expect(resolveDocument).not.toHaveBeenCalled();
    },
  );

  it("keeps unknown sources restricted, recognizes Calendar, and scans content beyond previews", async () => {
    const runtime = new SemanticSearchRuntime({
      sql: {} as postgres.Sql,
      getConfig: () => config,
      classifications: { get: async () => null },
    });
    const id = "10000000-0000-4000-8000-000000000001";
    const calendar: IndexDocument = {
      id: "calendar:event",
      type: "calendar",
      body: `Project meeting ${id}`,
      attributes: { orgId: "org", eventId: "event", organizerId: id },
    };
    expect((await runtime.classifyHit(request, calendar))?.attributes?.classification).toBe(
      "standard",
    );
    expect(
      (
        await runtime.classifyHit(request, {
          ...calendar,
          body: `${calendar.body ?? ""} 123-45-6789`,
        })
      )?.attributes?.classification,
    ).toBe("confidential");
    expect(
      (
        await runtime.classifyHit(request, {
          ...calendar,
          body: `${"ordinary ".repeat(1024)}\nClassification: restricted`,
        })
      )?.attributes?.classification,
    ).toBe("restricted");
    expect(
      (
        await runtime.classifyHit(request, {
          id: "unknown:1",
          type: "unknown",
          body: "ordinary",
          attributes: { orgId: "org" },
        })
      )?.attributes?.classification,
    ).toBe("restricted");
  });
});
