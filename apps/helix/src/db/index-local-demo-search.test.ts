import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  indexLocalDemoSearch,
  localDemoSearchDocumentsForAnchor,
  LOCAL_DEMO_SEARCH_DOCUMENTS,
} from "./index-local-demo-search.js";
import { LOCAL_DEMO_IDS } from "./seed-local-demo.js";

describe("indexLocalDemoSearch", () => {
  it("is a no-op when no search engine is configured", async () => {
    await expect(indexLocalDemoSearch({} as postgres.Sql)).resolves.toEqual({
      searchConfigured: false,
      indexedDocuments: 0,
      documentIds: [],
    });
  });

  it("keeps the curated search descriptor aligned with seeded Mail, Drive, Docs, Calendar, and Chat ids", () => {
    expect(LOCAL_DEMO_SEARCH_DOCUMENTS.map((document) => document.expectedId)).toEqual([
      `mail:${LOCAL_DEMO_IDS.mailAmazonMessage}`,
      `mail:${LOCAL_DEMO_IDS.mailRenovateMessage}`,
      `mail:${LOCAL_DEMO_IDS.mailPlanningMessage}`,
      `mail:${LOCAL_DEMO_IDS.mailPianoMessage}`,
      `drive:${LOCAL_DEMO_IDS.driveFileAiServices}`,
      `drive:${LOCAL_DEMO_IDS.driveFileTraining}`,
      `docs:${LOCAL_DEMO_IDS.docsQuarterly}`,
      `docs:${LOCAL_DEMO_IDS.docsRunbook}`,
      `calendar:${LOCAL_DEMO_IDS.eventOrderMatch}`,
      `calendar:${LOCAL_DEMO_IDS.eventPlanning}`,
      `chat:${LOCAL_DEMO_IDS.chatMessageLaunchPlan}`,
      `chat:${LOCAL_DEMO_IDS.chatMessageMailDensity}`,
      `chat:${LOCAL_DEMO_IDS.chatMessageCalendarPreview}`,
    ]);
    expect(countByType()).toEqual({
      calendar: 2,
      chat: 3,
      docs: 2,
      drive: 2,
      mail: 4,
    });
    expect(LOCAL_DEMO_SEARCH_DOCUMENTS.every((document) => document.query.length > 0)).toBe(true);
    expect(LOCAL_DEMO_SEARCH_DOCUMENTS.every((document) => document.expectedTitle.length > 0)).toBe(
      true,
    );
    expect(LOCAL_DEMO_SEARCH_DOCUMENTS.every((document) => document.expectedUrl.length > 0)).toBe(
      true,
    );
  });

  it("shifts calendar search descriptor dates for anchored demo data", () => {
    const anchored = localDemoSearchDocumentsForAnchor("2026-05-28");
    const calendar = anchored.filter((document) => document.type === "calendar");

    expect(calendar.map((document) => document.expectedAttributes?.startsAt)).toEqual([
      "2026-05-27T14:00:00.000Z",
      "2026-05-28T17:00:00.000Z",
    ]);
    expect(calendar.map((document) => document.expectedAttributes?.endsAt)).toEqual([
      "2026-05-27T15:00:00.000Z",
      "2026-05-28T17:45:00.000Z",
    ]);
    expect(localDemoSearchDocumentsForAnchor(undefined)).toEqual(LOCAL_DEMO_SEARCH_DOCUMENTS);
  });
});

function countByType(): Record<string, number> {
  return Object.fromEntries(
    [...new Set(LOCAL_DEMO_SEARCH_DOCUMENTS.map((document) => document.type))]
      .sort()
      .map((type) => [
        type,
        LOCAL_DEMO_SEARCH_DOCUMENTS.filter((document) => document.type === type).length,
      ]),
  );
}
