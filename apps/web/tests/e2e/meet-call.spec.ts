import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { installCoreAppsRoutes } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const accessToken = "e2e-meet-token";
const roomId = "33333333-3333-4333-8333-333333333333";
const serverUrl = "wss://rtc.helix.test";
const livekitToken = "livekit-access-token";

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

test.describe("/meet LiveKit call", () => {
  test("joins today's meeting through the pre-join screen and connects to LiveKit", async ({
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
    const stage = await page
      .getByRole("region", { name: "Meeting: Backend launch review" })
      .boundingBox();
    const viewport = page.viewportSize()!;
    expect(stage!.width).toBeGreaterThan(viewport.width * 0.8);
    expect(stage!.height).toBeGreaterThan(viewport.height * 0.5);
    expect(stage!.y + stage!.height).toBeLessThanOrEqual(viewport.height);
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const browser = window as typeof window & { axe: typeof axe };
      return (
        await browser.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
        })
      ).violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      }));
    });
    expect(violations).toEqual([]);
  });

  test("keeps an instant meeting code in the URL and returns to pre-join after reload", async ({
    page,
  }) => {
    await openMeet(page);
    await page.goto("/meet");
    await page.getByRole("button", { name: "New meeting" }).click();
    await page.getByRole("menuitem", { name: "Start an instant meeting" }).click();
    await page.getByRole("checkbox", { name: "I consent to recording and transcription" }).check();
    await page.getByRole("button", { name: "Join now", exact: true }).click();
    await expect(page.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/meet\?code=bckl-lnch-rvw0$/);
    await expect(page.getByRole("region", { name: "Meeting: Backend launch review" })).toHaveCount(
      1,
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ready to join?" })).toBeVisible();
    await expect(page).toHaveURL(/\/meet\?code=bckl-lnch-rvw0$/);
  });

  test("says Meet is unavailable, with the next step, when no meeting server is set up", async ({
    page,
  }) => {
    const message =
      "Meet needs a LiveKit media server. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET, then restart Helix.";
    const calls = await openMeet(page, { available: false, reason: "not_configured", message });
    await page.goto("/meet?code=bckl-lnch-rvw0");

    const notice = page.getByRole("status").filter({ hasText: "Meet is unavailable" });
    await expect(notice.getByRole("heading", { name: "Meet is unavailable" })).toBeVisible();
    await expect(notice).toContainText(message);
    await expect(page.getByRole("heading", { name: "Ready to join?" })).toHaveCount(0);
    expect(calls.some((call) => call.pathname === "/v1/api/tools/meet.join-by-code")).toBe(false);

    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const browser = window as typeof window & { axe: typeof axe };
      const result = await browser.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      });
      return result.violations.map((violation) => violation.id);
    });
    expect(violations).toEqual([]);
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

async function openMeet(
  page: Page,
  meetStatus: unknown = { available: true },
): Promise<MeetToolCall[]> {
  const calls: MeetToolCall[] = [];
  await page.addInitScript(
    ({ key, token }) => {
      window.localStorage.setItem(key, token);
    },
    { key: accessTokenStorageKey, token: accessToken },
  );
  await mockMeetTools(page, calls, meetStatus);
  await mockLiveKitSignal(page);
  return calls;
}

async function expectJoinedRoom(page: Page, calls: readonly MeetToolCall[]): Promise<void> {
  await page.getByRole("checkbox", { name: "I consent to recording and transcription" }).check();
  await page.getByRole("button", { name: "Join now", exact: true }).click();

  await expect
    .poll(() => calls.find((call) => call.pathname === "/v1/api/tools/meet.join-by-code")?.body)
    .toEqual(
      expect.objectContaining({
        code: "bckl-lnch-rvw0",
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-10-15",
        deviceId: expect.any(String),
        joinGrantId: expect.any(String),
      }),
    );

  // The browser opens LiveKit signalling on the server URL from the join
  // response, authenticating with the minted access token.
  await expect
    .poll(() => {
      const url = signalUrls.get(page)?.[0];
      return url === undefined
        ? null
        : { origin: url.origin, token: url.searchParams.get("access_token") };
    })
    .toEqual({ origin: serverUrl, token: livekitToken });
  await expect(page.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
}

const signalUrls = new WeakMap<Page, URL[]>();

/* No media server runs in mocked E2E: record the signalling URL and refuse
   the connection, so the call shows its connection error. */
async function mockLiveKitSignal(page: Page): Promise<void> {
  signalUrls.set(page, []);
  await page.routeWebSocket(/\/rtc/u, (socket) => {
    signalUrls.get(page)?.push(new URL(socket.url()));
    void socket.close({ code: 1011, reason: "no media server in mocked E2E" });
  });
  await page.route(/^https:\/\/rtc\.helix\.test\//u, (route) =>
    route.fulfill({ status: 503, body: "" }),
  );
}

async function mockMeetTools(page: Page, calls: MeetToolCall[], meetStatus: unknown) {
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

    if (pathname === "/v1/api/tools/meet.status") {
      await fulfillJson(route, meetStatus);
      return;
    }
    if (pathname === "/v1/api/tools/meet.meetings.list") {
      await fulfillJson(route, {
        meetings: [meetMeeting],
        active: [meetMeeting],
        scheduled: [],
        recent: [],
      });
      return;
    }
    if (pathname === "/v1/api/tools/meet.create-room") {
      await fulfillJson(route, { ...meetRoom, joinCode: meetMeeting.code });
      return;
    }
    if (
      pathname === "/v1/api/tools/meet.join-by-code" ||
      pathname === "/v1/api/tools/meet.mint-token"
    ) {
      await fulfillJson(route, {
        roomId,
        code: meetMeeting.code,
        subject: meetMeeting.subject,
        roomName: "backend-launch-review",
        serverUrl,
        token: livekitToken,
        joinUrl: serverUrl,
        expiresAt: "2026-05-20T13:00:00.000Z",
        recordingAvailable: true,
        canStartRecording: true,
        recordingNoticeVersion: "2026-10-15",
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
  mediaDomain: "rtc.helix.test",
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
