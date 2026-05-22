import { describe, expect, it } from "vitest";
import {
  MAIL_THREADS,
  type MailFolderId,
  type MailTabId,
} from "./mail-seed";
import { filterMailThreads, searchMailThreads, selectMailPool } from "./mail-search";

const inbox: MailFolderId = "inbox";
const primary: MailTabId = "primary";

describe("selectMailPool", () => {
  it("returns the threads for the active category tab", () => {
    const pool = selectMailPool(MAIL_THREADS, inbox, "updates");
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((thread) => thread.tab === "updates")).toBe(true);
  });

  it("returns only starred threads for the Starred folder", () => {
    const pool = selectMailPool(MAIL_THREADS, "starred", primary);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((thread) => thread.starred === true)).toBe(true);
  });

  it("returns an empty pool for seed-empty folders", () => {
    for (const folder of ["drafts", "snoozed", "trash", "archive", "sent"] as const) {
      expect(selectMailPool(MAIL_THREADS, folder, primary)).toHaveLength(0);
    }
  });
});

describe("filterMailThreads operator parser", () => {
  const pool = selectMailPool(MAIL_THREADS, inbox, primary);

  it("returns the full pool for an empty query", () => {
    expect(filterMailThreads(pool, "")).toBe(pool);
    expect(filterMailThreads(pool, "   ")).toBe(pool);
  });

  it("matches the from: operator on name or email", () => {
    const byName = filterMailThreads(pool, "from:mira");
    expect(byName.map((thread) => thread.id)).toEqual(["t1"]);
    const byEmail = filterMailThreads(pool, "from:security@helix.io");
    expect(byEmail.map((thread) => thread.id)).toEqual(["t2"]);
  });

  it("matches has:attachment", () => {
    const hits = filterMailThreads(pool, "has:attachment");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((thread) => thread.hasAttachment === true)).toBe(true);
  });

  it("matches the label: operator", () => {
    const hits = filterMailThreads(pool, "label:customers");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((thread) => thread.labels.includes("customers"))).toBe(true);
  });

  it("matches is:starred and is:unread", () => {
    expect(
      filterMailThreads(pool, "is:starred").every((thread) => thread.starred === true),
    ).toBe(true);
    expect(
      filterMailThreads(pool, "is:unread").every((thread) => thread.unread === true),
    ).toBe(true);
  });

  it("matches freeform terms across from, subject, preview and body", () => {
    expect(filterMailThreads(pool, "roadmap").map((thread) => thread.id)).toContain("t1");
    expect(filterMailThreads(pool, "postmortem").map((thread) => thread.id)).toContain(
      "t5",
    );
  });

  it("combines operators so every token must match", () => {
    const hits = filterMailThreads(pool, "is:unread has:attachment label:team");
    expect(hits.map((thread) => thread.id).sort()).toEqual(["t1", "t3"]);
    expect(
      hits.every(
        (thread) =>
          thread.unread === true &&
          thread.hasAttachment === true &&
          thread.labels.includes("team"),
      ),
    ).toBe(true);
  });

  it("returns no results when tokens cannot all match", () => {
    expect(filterMailThreads(pool, "from:nobody")).toHaveLength(0);
  });
});

describe("searchMailThreads", () => {
  it("composes pool selection and query filtering", () => {
    const hits = searchMailThreads(MAIL_THREADS, {
      folder: inbox,
      tab: primary,
      query: "is:starred",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((thread) => thread.starred === true && thread.tab === "primary")).toBe(
      true,
    );
  });
});
