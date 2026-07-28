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

test.describe("/meet Jitsi embed", () => {
  test("mints a backend token and initializes the configured Jitsi room", async ({
    page,
  }) => {
    const calls: MeetToolCall[] = [];

    await page.addInitScript(({ key, token }) => window.localStorage.setItem(key, token), {
      key: accessTokenStorageKey,
      token: accessToken,
    });
    await mockMeetTools(page, calls);
    await mockJitsiExternalApi(page);

    await page.goto("/meet");
    await expect(page.getByText("Backend launch review", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Join now", exact: true }).click();

    await expect
      .poll(() => calls.find((call) => call.pathname === "/api/tools/meet.mint-token")?.body)
      .toEqual({
        roomId,
        expiresInSeconds: 3600,
        moderator: false,
      });

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
  });
});

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

    if (pathname === "/api/tools/meet.meetings.list") {
      await fulfillJson(route, {
        meetings: [meetMeeting],
        active: [meetMeeting],
        scheduled: [],
        recent: [],
      });
      return;
    }
    if (pathname === "/api/tools/meet.mint-token") {
      await fulfillJson(route, {
        roomId,
        roomName: "backend-launch-review",
        jitsiDomain: "meet.helix.test",
        token: "jwt",
        joinUrl,
        expiresAt: "2026-05-20T13:00:00.000Z",
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
  code: "bck-lnd-rvw",
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
