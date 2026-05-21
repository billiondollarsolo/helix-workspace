// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadMeetRouteData, validateMeetRouteSearch } from "@/routes/_shell/meet";
import { MeetShell } from "./meet-shell";
import { meetQueryKeys } from "./queries";

const roomId = "33333333-3333-4333-8333-333333333333";
const listRoomId = "55555555-5555-4555-8555-555555555555";
const endedRoomId = "99999999-9999-4999-8999-999999999999";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MeetShell backend tool integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (input === "/api/tools/meet.room.list") {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { status?: "active" | "ended" })
            : {};
        const activeRoom = {
          id: listRoomId,
          orgId: "22222222-2222-4222-8222-222222222222",
          threadId: "66666666-6666-4666-8666-666666666666",
          roomName: "backend-daily-standup",
          subject: "Backend daily standup",
          jitsiDomain: "meet.helix.test",
          status: "active",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          startedAt: "2026-05-20T12:00:00.000Z",
          endedAt: null,
          metadata: {},
          recordingArtifacts: [
            {
              objectId: "77777777-7777-4777-8777-777777777777",
              messageId: "88888888-8888-4888-8888-888888888888",
              storageKey: "recordings/backend-daily-standup.mp4",
              mimeType: "video/mp4",
              byteSize: 2_097_152,
              createdAt: "2026-05-20T12:45:00.000Z",
              startedAt: "2026-05-20T12:00:00.000Z",
              endedAt: "2026-05-20T12:30:00.000Z",
              metadata: { source: "jibri" },
            },
          ],
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        };
        const endedRoom = {
          id: endedRoomId,
          orgId: "22222222-2222-4222-8222-222222222222",
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          roomName: "backend-retro",
          subject: "Backend retro",
          jitsiDomain: "meet.helix.test",
          status: "ended",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          startedAt: "2026-05-20T10:00:00.000Z",
          endedAt: "2026-05-20T11:00:00.000Z",
          metadata: {},
          recordingArtifacts: [],
          createdAt: "2026-05-20T10:00:00.000Z",
          updatedAt: "2026-05-20T11:00:00.000Z",
        };
        const rooms =
          body.status === "active"
            ? [activeRoom]
            : body.status === "ended"
              ? [endedRoom]
              : [activeRoom, endedRoom];
        return Promise.resolve(
          Response.json({
            rooms,
          }),
        );
      }
      if (input === "/api/tools/meet.create-room") {
        return Promise.resolve(
          Response.json({
            id: roomId,
            orgId: "22222222-2222-4222-8222-222222222222",
            threadId: "44444444-4444-4444-8444-444444444444",
            roomName: "backend-launch-review",
            subject: "Backend launch review",
            jitsiDomain: "meet.helix.test",
            status: "active",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            startedAt: "2026-05-20T12:00:00.000Z",
            endedAt: null,
            metadata: {},
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (input === "/api/tools/meet.mint-token") {
        return Promise.resolve(
          Response.json({
            roomId,
            roomName: "backend-launch-review",
            jitsiDomain: "meet.helix.test",
            token: "jwt",
            joinUrl:
              "https://meet.helix.test/backend-launch-review?jwt=jwt&config.prejoinPageEnabled=false",
            expiresAt: "2026-05-20T13:00:00.000Z",
          }),
        );
      }
      if (input === "/api/tools/meet.end-room") {
        return Promise.resolve(
          Response.json({
            id: roomId,
            threadId: "44444444-4444-4444-8444-444444444444",
            roomName: "backend-launch-review",
            subject: "Backend launch review",
            jitsiDomain: "meet.helix.test",
            status: "ended",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            startedAt: "2026-05-20T12:00:00.000Z",
            endedAt: "2026-05-20T13:00:00.000Z",
            metadata: {},
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T13:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads the initial backend Meet room list", async () => {
    renderMeet();
    await waitForText("Backend daily standup");
    await waitForText("Backend-created Jitsi room.");
    await waitForText("backend-daily-standup.mp4");
    await waitForText("30 min");
    await waitForText("2.0 MB - video/mp4");

    const roomList = container.querySelector(".meet-room-list");
    expect(roomList?.getAttribute("role")).toBe("region");
    expect(roomList?.getAttribute("aria-label")).toBe("Room list");
    expect(roomList?.getAttribute("tabindex")).toBe("0");
    expect(container.textContent).not.toContain("Launch readiness");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tools/meet.room.list");
  });

  it("preloads the route-derived Meet room list", async () => {
    expect(validateMeetRouteSearch({ room: endedRoomId, status: "live" })).toEqual({
      room: endedRoomId,
      status: "active",
    });
    expect(validateMeetRouteSearch({ room: "", status: "unknown" })).toEqual({});

    await preloadMeetRouteData(queryClient, { room: endedRoomId, status: "ended" });

    expect(queryClient.getQueryData(meetQueryKeys.rooms({ status: "ended", limit: 50 }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: endedRoomId, status: "ended" })]),
    );
    expect(toolCallBody("meet.room.list")).toEqual({ status: "ended", limit: 50 });
  });

  it("selects the route room and consumes the route status filter", async () => {
    renderMeet({ initialRoomId: endedRoomId, roomsQueryInput: { status: "ended", limit: 50 } });
    await waitForText("Backend retro");
    await waitForText("Ended");

    expect(container.querySelector(".meet-room-row.selected")?.textContent).toContain(
      "Backend retro",
    );
    expect(container.textContent).not.toContain("Backend daily standup");
    expect(toolCallBody("meet.room.list")).toEqual({ status: "ended", limit: 50 });
  });

  it("renders a backend empty state without sample Meet rooms", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/meet.room.list") {
        return Promise.resolve(Response.json({ rooms: [] }));
      }
      return Promise.resolve(Response.json({}));
    });

    renderMeet();
    await waitForText("No meeting rooms");

    expect(container.textContent).not.toContain("Launch readiness");
    expect(container.textContent).not.toContain("Design review");
    expect(container.textContent).not.toContain("Customer briefing");
  });

  it("creates a backend Meet room, mints a join token, and ends the room", async () => {
    renderMeet();
    await waitForText("Backend daily standup");

    await typeInput("#meet-room-name", "Backend launch review");
    await typeInput("#meet-room-slug", "backend-launch-review");
    await clickButton("Create room");
    await waitForText("Backend launch review");

    expect(toolCallBody("meet.create-room")).toMatchObject({
      subject: "Backend launch review",
      roomName: "helix-backend-launch-review",
      jitsiDomain: "meet.jit.si",
    });

    await clickButton("Join");
    await waitForText("meet.helix.test");
    expect(toolCallBody("meet.mint-token")).toEqual({
      roomId,
      expiresInSeconds: 3600,
      moderator: true,
    });
    const iframe = await waitForMeetIframe();
    expect(iframe.getAttribute("src")).toBe(
      "https://meet.helix.test/backend-launch-review?jwt=jwt&config.prejoinPageEnabled=false",
    );
    expect(iframe.getAttribute("allow")).toBe("camera; microphone; fullscreen; display-capture");
    expect(iframe.getAttribute("title")).toBe("Backend launch review Jitsi room");

    await clickButton("End");
    await waitForText("Ended");
    expect(toolCallBody("meet.end-room")).toEqual({ roomId });
    expect(container.querySelector(".meet-iframe")).toBeNull();
    await waitForText("Ready to join");
  });

  it("blocks Meet room creation when the room name is blank", async () => {
    renderMeet();
    await waitForText("Backend daily standup");

    await clickButton("Create room");
    await waitForText("Room name is required.");

    const roomNameInput = container.querySelector("#meet-room-name");
    expect(roomNameInput).toBeInstanceOf(HTMLInputElement);
    expect(roomNameInput?.getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/meet.create-room")).toBe(
      false,
    );
  });

  it("creates labelled Offline/local rooms when backend creation is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    renderMeet();
    await typeInput("#meet-room-name", "Offline room");
    await clickButton("Create room");

    await waitForText("Offline room");
    await waitForText("Meet backend unavailable");
    await waitForText("Offline/local");
    await waitForText("Local room available while Meet backend is offline.");
    expect(container.textContent).not.toContain("Launch readiness");

    await clickButton("Join");
    await waitForText("Live");
    await clickButton("End");
    await waitForText("Ended");
  });

  function renderMeet(props: React.ComponentProps<typeof MeetShell> = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MeetShell {...props} />
        </QueryClientProvider>,
      );
    });
  }

  async function clickButton(text: string) {
    const buttons = Array.from(container.querySelectorAll("button"));
    const button =
      buttons.find(
        (candidate) =>
          candidate.classList.contains("helix-button") && candidate.textContent?.includes(text),
      ) ?? buttons.find((candidate) => candidate.textContent?.includes(text));
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function typeInput(selector: string, value: string) {
    const input = container.querySelector(selector);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Input not found: ${selector}`);
    }
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set as ((this: HTMLInputElement, value: string) => void) | undefined;
      if (valueSetter !== undefined) {
        Reflect.apply(valueSetter, input, [value]);
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }

  function toolCallBody(toolId: string) {
    const call = fetchMock.mock.calls.find((candidate) => candidate[0] === `/api/tools/${toolId}`);
    const body = call?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Expected ${toolId} JSON body.`);
    }
    return JSON.parse(body) as unknown;
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitForMeetIframe() {
    await waitFor(() => {
      const iframe = container.querySelector(".meet-iframe");
      expect(iframe).toBeInstanceOf(HTMLIFrameElement);
    });
    const iframe = container.querySelector(".meet-iframe");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Expected Meet iframe.");
    }
    return iframe;
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await flush();
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }
});
