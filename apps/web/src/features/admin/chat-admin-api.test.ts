import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import {
  CHAT_PLATFORM_DEFAULT_RETENTION_DAYS,
  describeChatAdminUnavailable,
  exportChatOrganization,
  formatRetentionSummary,
  getChatRetentionPolicy,
  mapExportFormToToolInput,
  mapLegalHoldFormToToolInput,
  mapRetentionFormToToolInput,
  setChatLegalHold,
  setChatRetentionPolicy,
} from "./chat-admin-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mapRetentionFormToToolInput", () => {
  it("maps valid org-default retention fields", () => {
    expect(
      mapRetentionFormToToolInput({
        retentionDays: "90",
        editWindowSeconds: "3600",
        deleteWindowSeconds: "7200",
        roomId: "",
      }),
    ).toEqual({
      retentionDays: 90,
      editWindowSeconds: 3600,
      deleteWindowSeconds: 7200,
    });
  });

  it("includes roomId only when a valid UUID is provided", () => {
    expect(
      mapRetentionFormToToolInput({
        retentionDays: "30",
        editWindowSeconds: "86400",
        deleteWindowSeconds: "86400",
        roomId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({
      retentionDays: 30,
      editWindowSeconds: 86_400,
      deleteWindowSeconds: 86_400,
      roomId: "33333333-3333-4333-8333-333333333333",
    });
    expect(
      mapRetentionFormToToolInput({
        retentionDays: "30",
        editWindowSeconds: "86400",
        deleteWindowSeconds: "86400",
        roomId: "not-a-uuid",
      }),
    ).toBe("Room ID must be a valid UUID when provided.");
  });

  it("rejects out-of-range retention days", () => {
    expect(
      mapRetentionFormToToolInput({
        retentionDays: "0",
        editWindowSeconds: "86400",
        deleteWindowSeconds: "86400",
        roomId: "",
      }),
    ).toBe("Retention days must be an integer from 1 to 36500.");
  });
});

describe("mapLegalHoldFormToToolInput", () => {
  it("maps enabled flag and optional room", () => {
    expect(mapLegalHoldFormToToolInput({ enabled: true, roomId: "" })).toEqual({
      enabled: true,
    });
    expect(
      mapLegalHoldFormToToolInput({
        enabled: false,
        roomId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({
      enabled: false,
      roomId: "33333333-3333-4333-8333-333333333333",
    });
  });
});

describe("mapExportFormToToolInput", () => {
  it("maps date range, limit, and room list", () => {
    expect(
      mapExportFormToToolInput({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
        limit: "500",
        roomIds: "33333333-3333-4333-8333-333333333333, 44444444-4444-4444-8444-444444444444",
      }),
    ).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      limit: 500,
      roomIds: ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"],
    });
  });

  it("rejects inverted date ranges and bad room ids", () => {
    expect(
      mapExportFormToToolInput({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
        limit: "100",
        roomIds: "",
      }),
    ).toBe("Export start must not be after export end.");
    expect(
      mapExportFormToToolInput({
        from: "",
        to: "",
        limit: "100",
        roomIds: "bad-id",
      }),
    ).toBe('Room ID "bad-id" is not a valid UUID.');
  });

  it("defaults empty room list and enforces limit bounds", () => {
    expect(
      mapExportFormToToolInput({
        from: "",
        to: "",
        limit: "10000",
        roomIds: "",
      }),
    ).toEqual({ roomIds: [], limit: 10_000 });
    expect(
      mapExportFormToToolInput({
        from: "",
        to: "",
        limit: "10001",
        roomIds: "",
      }),
    ).toBe("Export limit must be an integer from 1 to 10000.");
  });
});

describe("formatRetentionSummary / describeChatAdminUnavailable", () => {
  it("describes platform defaults honestly", () => {
    expect(
      formatRetentionSummary({
        orgId: "22222222-2222-4222-8222-222222222222",
        roomId: null,
        retentionDays: CHAT_PLATFORM_DEFAULT_RETENTION_DAYS,
        editWindowSeconds: 86_400,
        deleteWindowSeconds: 86_400,
        legalHold: false,
        updatedAt: null,
        configured: false,
      }),
    ).toContain("platform default");
  });

  it("explains missing scope and missing chat tools", () => {
    expect(describeChatAdminUnavailable(new Error("chat.retention.get failed with 403"))).toContain(
      "admin.chat",
    );
    expect(
      describeChatAdminUnavailable(
        new Error("This Chat store does not support retention policies."),
      ),
    ).toContain("not enabled");
  });
});

describe("chat admin tool clients", () => {
  let fetchImpl: ReturnType<typeof vi.fn<AuthFetch>>;

  beforeEach(() => {
    fetchImpl = vi.fn<AuthFetch>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads retention policy via chat.retention.get", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        orgId: "22222222-2222-4222-8222-222222222222",
        roomId: null,
        retentionDays: 90,
        editWindowSeconds: 86_400,
        deleteWindowSeconds: 86_400,
        legalHold: false,
        updatedAt: "2026-08-01T00:00:00.000Z",
        configured: true,
      }),
    );

    const policy = await getChatRetentionPolicy({}, fetchImpl);
    expect(policy.retentionDays).toBe(90);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/chat.retention.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it("sets retention through pending confirmation then approve", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({
          status: "pending_confirmation",
          pending: { id: "pending-1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "executed",
          output: {
            orgId: "22222222-2222-4222-8222-222222222222",
            roomId: null,
            retentionDays: 30,
            editWindowSeconds: 3600,
            deleteWindowSeconds: 3600,
            legalHold: false,
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );

    const result = await setChatRetentionPolicy(
      {
        retentionDays: 30,
        editWindowSeconds: 3600,
        deleteWindowSeconds: 3600,
      },
      fetchImpl,
    );
    expect(result.retentionDays).toBe(30);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "/api/tools/chat.retention.set",
      "/api/tools/pending/pending-1/approve",
    ]);
  });

  it("sets legal hold and exports organization messages", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({
          status: "pending_confirmation",
          pending: { id: "pending-hold" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "executed",
          output: {
            orgId: "22222222-2222-4222-8222-222222222222",
            roomId: null,
            retentionDays: 2555,
            editWindowSeconds: 86_400,
            deleteWindowSeconds: 86_400,
            legalHold: true,
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "pending_confirmation",
          pending: { id: "pending-export" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "executed",
          output: {
            exportId: "66666666-6666-4666-8666-666666666666",
            orgId: "22222222-2222-4222-8222-222222222222",
            generatedAt: "2026-08-02T12:00:00.000Z",
            truncated: false,
            messages: [],
          },
        }),
      );

    const hold = await setChatLegalHold({ enabled: true }, fetchImpl);
    expect(hold.legalHold).toBe(true);

    const exported = await exportChatOrganization({ roomIds: [], limit: 100 }, fetchImpl);
    expect(exported.exportId).toBe("66666666-6666-4666-8666-666666666666");
    expect(exported.messages).toEqual([]);
  });

  it("surfaces unauthorized retention reads", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    await expect(getChatRetentionPolicy({}, fetchImpl)).rejects.toThrow(/403|forbidden/i);
  });
});
