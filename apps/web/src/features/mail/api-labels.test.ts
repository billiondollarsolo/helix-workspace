import { describe, expect, it, vi } from "vitest";
import {
  cancelScheduledMail,
  createMailLabel,
  deleteMailLabel,
  listScheduledMail,
  rescheduleMail,
  updateMailLabel,
} from "./api";

function toolFetch(output: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(Response.json(output)));
}

function bodyOf(fetchImpl: ReturnType<typeof toolFetch>, call: number) {
  const init = fetchImpl.mock.calls[call]?.[1];
  return JSON.parse(init?.body as string) as unknown;
}

describe("mail label and scheduled-send API", () => {
  it("creates, updates and deletes labels through the label tools", async () => {
    const label = { id: "label-1", name: "Clients", colorName: "green" };
    const fetchImpl = toolFetch({ label, deletedIds: ["label-1", "label-2"] });

    await expect(createMailLabel({ name: "Clients", color: "green" }, fetchImpl)).resolves.toEqual(
      label,
    );
    await expect(
      updateMailLabel({ id: "label-1", parentId: null, color: "blue" }, fetchImpl),
    ).resolves.toEqual(label);
    await expect(deleteMailLabel("label-1", fetchImpl)).resolves.toEqual(["label-1", "label-2"]);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/tools/mail.label.create",
      "/api/tools/mail.label.update",
      "/api/tools/mail.label.delete",
    ]);
    expect(bodyOf(fetchImpl, 1)).toEqual({ id: "label-1", parentId: null, color: "blue" });
  });

  it("lists, reschedules and cancels scheduled sends", async () => {
    const scheduled = { outboundId: "out-1", sendAt: "2026-10-12T08:00:00.000Z" };
    const fetchImpl = toolFetch({
      scheduled,
      total: 1,
      cancelled: true,
      draftId: "draft-1",
    });

    await expect(listScheduledMail({ limit: 10 }, fetchImpl)).resolves.toMatchObject({
      total: 1,
    });
    await expect(
      rescheduleMail({ outboundId: "out-1", sendAt: scheduled.sendAt }, fetchImpl),
    ).resolves.toEqual(scheduled);
    await expect(cancelScheduledMail("out-1", fetchImpl)).resolves.toMatchObject({
      cancelled: true,
      draftId: "draft-1",
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/tools/mail.scheduled.list",
      "/api/tools/mail.scheduled.reschedule",
      "/api/tools/mail.scheduled.cancel",
    ]);
    expect(bodyOf(fetchImpl, 2)).toEqual({ outboundId: "out-1" });
  });
});
