import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  indexLocalDemoSearch,
  localDemoSearchDocumentsForAnchor,
  LOCAL_DEMO_SEARCH_DOCUMENTS,
} from "./index-local-demo-search.js";
import { LOCAL_DEMO_IDS } from "./seed-local-demo.js";

describe("indexLocalDemoSearch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a no-op when no search engine is configured", async () => {
    /* The premise has to be established, not assumed. This asserted a no-op
       while reading the ambient environment, so on any machine with the dev
       stack running -- MEILI_URL is in the repo's own env -- an engine WAS
       configured, the guard did not fire, and the `{}` standing in for a
       database blew up with "this.sql is not a function". Every variable the
       env reader consults is cleared. */
    for (const key of [
      "MEILI_URL",
      "MEILISEARCH_URL",
      "MEILI_HOST",
      "MEILI_MASTER_KEY",
      "MEILI_API_KEY",
      "MEILISEARCH_API_KEY",
    ]) {
      vi.stubEnv(key, "");
    }

    await expect(indexLocalDemoSearch({} as postgres.Sql)).resolves.toEqual({
      searchConfigured: false,
      indexedDocuments: 0,
      documentIds: [],
    });
  });

  it("does not touch the database before deciding there is no engine", async () => {
    /* The guard's whole value: `indexLocalDemoSearch` is called at boot with a
       real client, and reaching for it when indexing is off would run five
       stores' queries for nothing. A Proxy that throws on any access proves
       nothing was read. */
    for (const key of ["MEILI_URL", "MEILISEARCH_URL", "MEILI_HOST"]) {
      vi.stubEnv(key, "");
    }
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be touched when search is unconfigured");
        },
        apply() {
          throw new Error("the database must not be queried when search is unconfigured");
        },
      },
    ) as postgres.Sql;

    await expect(indexLocalDemoSearch(forbidden)).resolves.toMatchObject({
      searchConfigured: false,
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
