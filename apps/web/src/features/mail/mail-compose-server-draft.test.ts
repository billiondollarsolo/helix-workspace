import { describe, expect, it } from "vitest";
import type { MailDraft } from "@helix/contracts";
import { reconcileMailComposeDrafts } from "./mail-compose-recovery";
import {
  filterMailDraftRecords,
  hydrationFromReconcile,
  pickLatestMailDraft,
  serverDraftToComposeFields,
} from "./mail-compose-server-draft";

function draft(overrides: Partial<MailDraft> & Pick<MailDraft, "id" | "updatedAt">): MailDraft {
  return {
    orgId: "00000000-0000-4000-8000-000000000001",
    actorId: "00000000-0000-4000-8000-000000000002",
    threadId: null,
    to: [{ address: "a@example.com" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    bodyText: "Body",
    attachments: [],
    version: 1,
    createdAt: overrides.updatedAt,
    ...overrides,
  };
}

describe("mail compose server draft helpers (UX.10)", () => {
  it("maps server drafts to compose fields and picks the latest", () => {
    const older = draft({
      id: "11111111-1111-4111-8111-111111111111",
      updatedAt: "2026-01-01T00:00:00.000Z",
      subject: "Older",
    });
    const newer = draft({
      id: "22222222-2222-4222-8222-222222222222",
      updatedAt: "2026-06-01T00:00:00.000Z",
      subject: "Newer",
      to: [{ address: "b@example.com" }],
      bodyText: "Latest body",
    });
    expect(pickLatestMailDraft([older, newer])?.id).toBe(newer.id);
    expect(serverDraftToComposeFields(newer)).toEqual({
      to: "b@example.com",
      cc: "",
      bcc: "",
      subject: "Newer",
      body: "Latest body",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("filters unknown list payloads without inventing drafts", () => {
    expect(filterMailDraftRecords([{ not: "a draft" }, null, "x"])).toEqual([]);
    expect(
      filterMailDraftRecords([
        draft({ id: "33333333-3333-4333-8333-333333333333", updatedAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ).toHaveLength(1);
  });

  it("builds conflict hydration from reconcile without silent overwrite", () => {
    const server = draft({
      id: "44444444-4444-4444-8444-444444444444",
      updatedAt: "2026-03-01T00:00:00.000Z",
      subject: "Server",
      bodyText: "Server body",
    });
    const local = {
      to: "local@example.com",
      cc: "",
      bcc: "",
      subject: "Local",
      body: "Local body",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };
    const decision = reconcileMailComposeDrafts({
      local,
      server: serverDraftToComposeFields(server),
    });
    expect(decision.action).toBe("conflict");
    const hydration = hydrationFromReconcile({ decision, serverDraft: server });
    expect(hydration.kind).toBe("conflict");
    if (hydration.kind === "conflict") {
      expect(hydration.local.subject).toBe("Local");
      expect(hydration.server.subject).toBe("Server");
      expect(hydration.serverDraftId).toBe(server.id);
    }
  });

  it("clears local recovery when use-server with clearLocal", () => {
    const server = draft({
      id: "55555555-5555-4555-8555-555555555555",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const local = {
      to: "a@example.com",
      cc: "",
      bcc: "",
      subject: "Hello",
      body: "Body",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const decision = reconcileMailComposeDrafts({
      local,
      server: serverDraftToComposeFields(server),
    });
    expect(decision.action).toBe("use-server");
    const hydration = hydrationFromReconcile({ decision, serverDraft: server });
    expect(hydration).toMatchObject({
      kind: "fields",
      clearLocal: true,
      serverDraftId: server.id,
    });
  });
});
