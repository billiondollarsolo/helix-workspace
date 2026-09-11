import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiRetrievalStatusQueryOptions,
  reindexJobQueryOptions,
  startAIRetrievalReindex,
  testAIRetrieval,
} from "./ai-retrieval-api";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock("@/lib/auth", () => ({ authenticatedFetch: fetchMock }));
beforeEach(() => fetchMock.mockReset());
describe("saved retrieval requests", () => {
  it("sends only the saved target and validates the connection result", async () => {
    const result = {
      ok: false,
      message: "Embedding model unavailable. Select an embedding model.",
      latencyMs: 15,
      checkedAt: "2026-09-10T18:00:00Z",
    };
    fetchMock.mockResolvedValue(Response.json(result));
    await expect(testAIRetrieval("vector")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/ai-retrieval/test",
      expect.objectContaining({ method: "POST", body: '{"target":"vector"}' }),
    );
  });
  it.each([
    null,
    {},
    { ok: true },
    { ok: true, message: "OK", latencyMs: "12", checkedAt: "today" },
  ])("rejects malformed test success %j", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(testAIRetrieval("web")).rejects.toThrow("invalid result");
  });
  it("surfaces permission failures without pretending a probe succeeded", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "Requires admin.config.write." }, { status: 403 }),
    );
    await expect(testAIRetrieval("web")).rejects.toThrow("Requires admin.config.write.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("queues only an explicit reindex and keeps an absent job disabled", async () => {
    const job = { id: "job-1", status: "queued", phase: "backfill", totalDocuments: "0" };
    fetchMock.mockResolvedValue(Response.json(job));
    await expect(startAIRetrievalReindex()).resolves.toEqual(job);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/ai-retrieval/reindex",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(reindexJobQueryOptions(null).enabled).toBe(false);
    expect(aiRetrievalStatusQueryOptions().queryKey).toEqual(["admin", "ai-retrieval", "status"]);
  });
});
