import { expect, test, type Page, type Route } from "@playwright/test";
import { installCoreAppsRoutes } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const accessToken = "e2e-meet-token";
const roomId = "33333333-3333-4333-8333-333333333333";
const joinUrl =
  "https://meet.helix.test/backend-launch-review?jwt=jwt&config.prejoinPageEnabled=false";

interface MeetToolCall {
  readonly authorization: string | null;
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
}

test.use({
  permissions: ["camera", "microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

test.describe("/meet Jitsi embed", () => {
  test("joins today's meeting through the pre-join screen and loads the Jitsi room", async ({
    page,
  }) => {
    const calls = await openMeet(page);
    await page.goto("/meet");
    const today = page.getByRole("region", { name: "Today" });
    await expect(today.getByText("Backend launch review", { exact: true })).toBeVisible();
    await today.getByRole("button", { name: "Join Backend launch review" }).click();

    await expect(page).toHaveURL(/\/meet\?code=bckl-lnch-rvw0$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ready to join?" })).toBeVisible();
    await expect(page.getByText("Backend launch review", { exact: true })).toBeVisible();
    await expectJoinedRoom(page, calls);
  });

  test("opens the pre-join screen straight from a calendar join link", async ({ page }) => {
    const calls = await openMeet(page);
    await page.goto("/meet?code=bckl-lnch-rvw0");
    await expect(page.getByRole("heading", { level: 1, name: "Ready to join?" })).toBeVisible();
    await expect(page.getByText("bckl-lnch-rvw0", { exact: true })).toBeVisible();
    await expectJoinedRoom(page, calls);
  });

  test("previews the camera and microphone with toggles and device pickers", async ({ page }) => {
    await openMeet(page);
    await page.goto("/meet?code=bckl-lnch-rvw0");
    const preview = page.getByRole("region", { name: "Camera and microphone preview" });
    await expect(preview.getByLabel("Your camera preview")).toBeVisible();
    await expect(preview.getByRole("combobox", { name: "Microphone" })).toBeEnabled();
    await expect(preview.getByRole("combobox", { name: "Camera" })).toBeEnabled();

    await preview.getByRole("button", { name: "Turn off camera" }).click();
    await expect(preview.getByText("Camera is off")).toBeVisible();
    await expect(preview.getByRole("button", { name: "Turn on camera" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await preview.getByRole("button", { name: "Turn off microphone" }).click();
    await expect(preview.getByRole("button", { name: "Turn on microphone" })).toBeVisible();

    // Joining needs the recording notice accepted, at the moment of joining.
    await page.getByRole("button", { name: "Join now", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Accept the recording notice to join.");
  });
});

async function openMeet(page: Page): Promise<MeetToolCall[]> {
  const calls: MeetToolCall[] = [];
  await page.addInitScript(
    ({ key, token }) => {
      window.localStorage.setItem(key, token);
    },
    { key: accessTokenStorageKey, token: accessToken },
  );
  await mockMeetTools(page, calls);
  await mockJitsiExternalApi(page);
  return calls;
}

async function expectJoinedRoom(page: Page, calls: readonly MeetToolCall[]): Promise<void> {
  await page.getByRole("checkbox", { name: "I consent to this meeting being recorded" }).check();
  await page.getByRole("button", { name: "Join now", exact: true }).click();

  await expect
    .poll(() => calls.find((call) => call.pathname === "/v1/api/tools/meet.join-by-code")?.body)
    .toEqual(
      expect.objectContaining({
        code: "bckl-lnch-rvw0",
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-09-02",
        deviceId: expect.any(String),
        joinGrantId: expect.any(String),
      }),
    );

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __helixJitsiE2E?: {
                readonly domain: string;
                readonly jwt: string;
                readonly roomName: string;
              };
            }
          ).__helixJitsiE2E ?? null,
      ),
    )
    .toEqual({
      domain: "meet.helix.test",
      jwt: "jwt",
      roomName: "backend-launch-review",
    });
  await expect(page.locator(".meet-iframe")).toHaveAttribute(
    "allow",
    "camera; microphone; fullscreen; display-capture; autoplay",
  );
  await expect(page.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
}

async function mockJitsiExternalApi(page: Page): Promise<void> {
  await page.route("https://meet.helix.test/external_api.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        window.JitsiMeetExternalAPI = class {
          constructor(domain, options) {
            window.__helixJitsiE2E = {
              domain,
              jwt: options.jwt,
              roomName: options.roomName,
            };
            this.iframe = document.createElement("iframe");
            this.iframe.className = "meet-iframe";
            options.parentNode.append(this.iframe);
          }
          addListener(event, handler) {
            if (event === "videoConferenceJoined") {
              queueMicrotask(() => handler({}));
            }
          }
          executeCommand() {}
          dispose() {
            this.iframe.remove();
          }
          getIFrame() {
            return this.iframe;
          }
        };
      `,
    });
  });
}

async function mockMeetTools(page: Page, calls: MeetToolCall[]) {
  // The production shell calls GET /api/core-apps on mount; this spec's route
  // matcher (`**/api/tools/**`) is narrower than that path, so stub the
  // core-app routes explicitly with the shared valid fixtures.
  await installCoreAppsRoutes(page);

  await page.route("**/api/tools/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const postData = request.postData();
    const call = {
      authorization: request.headers().authorization ?? null,
      body: postData === null || postData.length === 0 ? null : JSON.parse(postData),
      method: request.method(),
      pathname,
    } satisfies MeetToolCall;
    calls.push(call);

    if (pathname === "/v1/api/tools/meet.meetings.list") {
      await fulfillJson(route, {
        meetings: [meetMeeting],
        active: [meetMeeting],
        scheduled: [],
        recent: [],
      });
      return;
    }
    if (pathname === "/v1/api/tools/meet.join-by-code") {
      await fulfillJson(route, {
        roomId,
        code: meetMeeting.code,
        subject: meetMeeting.subject,
        roomName: "backend-launch-review",
        jitsiDomain: "meet.helix.test",
        token: "jwt",
        joinUrl,
        expiresAt: "2026-05-20T13:00:00.000Z",
        recordingAvailable: true,
        canStartRecording: true,
        recordingNoticeVersion: "2026-09-02",
        canModerate: true,
        controls: {
          roomId,
          hostActorId: "11111111-1111-4111-8111-111111111111",
          cohostActorIds: [],
          lobbyEnabled: true,
          locked: false,
          mutePolicy: "open",
          presenterPolicy: "everyone",
          presenterSubject: null,
          chatPolicy: "everyone",
          reactionPolicy: "everyone",
          version: 1,
        },
      });
      return;
    }

    await fulfillJson(route, {});
  });
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

const meetRoom = {
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
  recordingArtifacts: [],
  createdAt: "2026-05-20T12:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
};

const meetMeeting = {
  ...meetRoom,
  title: meetRoom.subject,
  code: "bckl-lnch-rvw0",
  host: {
    actorId: meetRoom.createdByActorId,
    displayName: "Avery Park",
    email: "admin@helix.local",
    role: "owner",
  },
  attendees: [],
  attendeeCount: 1,
  scheduledStartAt: null,
  scheduledEndAt: null,
  durationSeconds: null,
  recorded: false,
  summaries: [],
};
