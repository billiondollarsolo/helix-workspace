import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const conversationId = "10000000-0000-4000-8000-000000000001";
const userMessageId = "30000000-0000-4000-8000-000000000001";
const branchId = "40000000-0000-4000-8000-000000000001";
const objectId = "20000000-0000-4000-8000-000000000001";
const models = ["llama-3.3-70b-versatile", "openai/gpt-oss-20b", "openai/gpt-oss-120b"].map(
  (model) => ({ id: `groq/${model}`, label: model, model, providerId: "groq" }),
);
const attachment = { objectId, name: "notes.ts", mimeType: "text/plain", byteSize: 23 };
const forecastTable =
  "| Element | Details |\n| --- | --- |\n| Temperature | **80°F** |\n| Source | [Forecast source](https://weather.example/forecast) |\n\n";
const markdown =
  forecastTable +
  '# Review\n\n**Safe summary** with `inline code`.\n\n- First step\n- Second step\n\n[Reference](https://example.test)\n\n```typescript\nconst answer = "' +
  "long ".repeat(60) +
  '";\n```\n\n![remote image](https://untrusted.example/pixel)\n\n<script>alert("no")</script>';
const sources = [
  {
    id: "source-search",
    type: "web.search",
    title: "Forecast search result",
    url: "https://weather.example/search",
  },
  {
    id: "source-page",
    type: "web.fetch",
    title: "Forecast page read",
    url: "https://weather.example/forecast",
  },
];
const toolActivity = [
  { toolCallId: "search-1", toolId: "web.search", status: "executed" },
  {
    toolCallId: "fetch-1",
    toolId: "web.fetch",
    status: "failed",
    error: "Page unavailable. Try another source.",
  },
];
const groups = [
  { id: "mail", label: "Mail", count: 8, defaultEnabled: true },
  { id: "drive", label: "Drive", count: 4, defaultEnabled: true },
  { id: "admin", label: "Admin", count: 3, defaultEnabled: false },
  { id: "other", label: "Workspace search and other tools", count: 1, defaultEnabled: true },
  { id: "calendar", label: "Calendar", count: 0, defaultEnabled: true },
];
const savedMessages = [
  {
    id: userMessageId,
    role: "user",
    content: "Review the attached file",
    attachments: [attachment],
    toolGroups: ["mail", "drive", "other"],
  },
  { id: "assistant-intermediate", role: "assistant", content: "", sources, toolActivity },
  { id: "assistant-1", role: "assistant", content: markdown, sources, toolActivity },
];

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Assistant fault injection uses an isolated mock backend."),
);
test.use({ timezoneId: "America/New_York" });

test("selects a model, scans uploads before sending, retains failed drafts and reopens persisted attachments", async ({
  page,
  context,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const backend = await mockBackend(page, true);
  await page.goto("/assistant");
  await page
    .getByRole("combobox", { name: "Assistant model" })
    .selectOption("groq/openai/gpt-oss-20b");
  const composer = page.getByRole("textbox", { name: "Message Helix AI" });
  await composer.fill("Review the attached file");
  await page
    .getByLabel("Attach", { exact: true })
    .setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("binary") });
  await expect(page.getByRole("alert")).toContainText("Use text, images, or PDFs");
  expect(backend.uploads).toBe(0);
  await page.getByLabel("Attach", { exact: true }).setInputFiles({
    name: attachment.name,
    mimeType: attachment.mimeType,
    buffer: Buffer.from("const answer = 42;\n"),
  });
  await expect(page.getByRole("list", { name: "Attachments to send" })).toContainText("Scanning…");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  backend.clean = true;
  await expect(page.getByRole("list", { name: "Attachments to send" })).toContainText("Ready");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Provider is busy. Try again.");
  await expect(composer).toHaveValue("Review the attached file");
  await expect(page.getByRole("list", { name: "Attachments to send" })).toContainText(
    attachment.name,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  expect(backend.requests).toEqual(
    Array.from({ length: 2 }, () => ({
      message: "Review the attached file",
      metadata: { timeZone: "America/New_York" },
      modelId: "groq/openai/gpt-oss-20b",
      attachmentObjectIds: [objectId],
      webSearch: false,
      toolGroups: ["mail", "drive", "other"],
    })),
  );
  expect(backend.uploads).toBe(1);
  expect(backend.puts).toBe(1);
  expect(backend.finalizations).toBe(1);
  await page.getByRole("button", { name: "Copy typescript code" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('const answer = "long');
  await expect(page.locator(".assistant-markdown img, .assistant-markdown script")).toHaveCount(0);
  expect(backend.remoteRequests).toBe(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  const download = page
    .getByRole("list", { name: "Message attachments" })
    .getByRole("link", { name: attachment.name });
  await expect(download).toHaveAttribute(
    "href",
    `/v1/api/drive/objects/${objectId}/content?download=1`,
  );
  await expect(composer).toHaveValue("");
  expect(consoleErrors.filter((message) => message.includes("flushSync"))).toEqual([]);
});

test("copies messages and edits or resends a preserved conversation branch", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const backend = await mockBackend(page, true);
  await page.goto(`/assistant?conversation=${conversationId}`);
  const composer = page.getByRole("textbox", { name: "Message Helix AI" });
  await page.getByRole("button", { name: "Copy message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Review the attached file");
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
  const options = page.getByRole("button", { name: "More composer options" });
  await options.click();
  await expect(page.getByRole("menuitem", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New chat" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
  backend.clean = true;
  await composer.fill("Keep my separate unsent draft");
  await page.getByLabel("Attach", { exact: true }).setInputFiles({
    name: "draft.ts",
    mimeType: "text/plain",
    buffer: Buffer.from("const draft = true;"),
  });
  await expect(page.getByRole("list", { name: "Attachments to send" })).toContainText("Ready");
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(composer).toHaveValue("Review the attached file");
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await expect(composer).toHaveValue("Keep my separate unsent draft");
  await expect(page.getByRole("list", { name: "Attachments to send" })).toContainText("draft.ts");
  expect(backend.uploads).toBe(1);
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(composer).toHaveValue("Review the attached file");
  await expect(composer).toBeFocused();
  await page.getByRole("button", { name: "Remove notes.ts" }).click();
  await composer.fill("Review the revised question");
  await composer.press("Enter");
  await expect(page.getByText("Provider is busy. Try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Review the revised question");
  await expect(page).toHaveURL(new RegExp(`conversation=${conversationId}`));
  await composer.press("Enter");
  await expect(page).toHaveURL(new RegExp(`conversation=${branchId}`));
  expect(backend.requests).toEqual(
    Array.from({ length: 2 }, () => ({
      conversationId,
      metadata: { timeZone: "America/New_York" },
      editMessageId: userMessageId,
      message: "Review the revised question",
      modelId: models[0]?.id,
      attachmentObjectIds: [],
      webSearch: false,
      toolGroups: ["mail", "drive", "other"],
    })),
  );
  await expect(page.getByTestId("assistant-conversation")).toContainText(
    "Review the revised question",
  );
  await expect(page.getByTestId("assistant-conversation")).not.toContainText(
    "Review the attached file",
  );
  await expect(page.getByRole("list", { name: "Message attachments" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("assistant-conversation")).toContainText(
    "Review the revised question",
  );
  await page.goto(`/assistant?conversation=${conversationId}`);
  await expect(page.getByTestId("assistant-conversation")).toContainText(
    "Review the attached file",
  );
  await expect(page.getByRole("list", { name: "Message attachments" })).toContainText(
    attachment.name,
  );
  await page.getByRole("button", { name: "Resend message", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`conversation=${branchId}`));
  expect(backend.requests.at(-1)).toMatchObject({
    conversationId,
    editMessageId: userMessageId,
    message: "Review the attached file",
    attachmentObjectIds: [objectId],
  });
});

test("blocks a quarantined attachment and lets the user remove it", async ({ page }) => {
  const backend = await mockBackend(page);
  backend.quarantined = true;
  await page.goto("/assistant");
  await page.getByRole("textbox", { name: "Message Helix AI" }).fill("Read this file");
  await page
    .getByLabel("Attach", { exact: true })
    .setInputFiles({ name: "blocked.txt", mimeType: "text/plain", buffer: Buffer.from("blocked") });
  await expect(page.getByRole("alert")).toContainText("unavailable after scanning");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove blocked.txt", exact: true }).click();
  await expect(page.getByRole("list", { name: "Attachments to send" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  expect(backend.requests).toEqual([]);
});

for (const outcome of ["executed", "failed", "cancelled"] as const) {
  test(`shows the actual ${outcome} approval turn and preserves it on reload`, async ({ page }) => {
    const backend = await mockBackend(page);
    const initial = [
      { id: userMessageId, role: "user", content: "Share notes", attachments: [] },
      {
        id: "60000000-0000-4000-8000-000000000001",
        role: "assistant",
        content: "Review this action.",
      },
    ];
    const pendingId = "70000000-0000-4000-8000-000000000001";
    await page.route("**/api/tools/assistant.chat", async (route) => {
      await route.fulfill({
        json: {
          conversation: { id: conversationId },
          messages: initial,
          response: { content: "Review this action." },
          pendingConfirmations: [{ id: pendingId, toolId: "drive.share" }],
        },
      });
    });
    const response =
      outcome === "executed"
        ? "Shared notes with the requested teammate."
        : outcome === "failed"
          ? "The notes were not shared."
          : "Cancelled the action. No files were shared.";
    await page.route("**/api/tools/assistant.confirmation.*", async (route) => {
      const messages = [
        ...initial,
        { id: "80000000-0000-4000-8000-000000000001", role: "assistant", content: response },
      ];
      backend.conversations[conversationId] = messages;
      await route.fulfill({
        json: {
          conversation: { id: conversationId },
          messages,
          response: { content: response },
          toolCalls: [
            {
              toolCallId: pendingId,
              toolId: "drive.share",
              status: outcome === "cancelled" ? "skipped" : outcome,
              ...(outcome === "failed" ? { error: "Access changed before execution." } : {}),
            },
          ],
          pendingConfirmations: [],
        },
      });
    });
    await page.goto("/assistant");
    await page.getByRole("textbox", { name: "Message Helix AI" }).fill("Share notes");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page
      .getByRole("button", { name: outcome === "cancelled" ? "Deny" : "Approve", exact: true })
      .click();
    await expect(page.getByTestId("assistant-conversation")).toContainText(response);
    await expect(page.getByTestId("pending-approvals-panel")).toHaveCount(0);
    if (outcome === "failed")
      await expect(page.getByRole("status")).toContainText("Access changed before execution.");
    await page.reload();
    await expect(page.getByTestId("assistant-conversation")).toContainText(response);
  });
}

test("web search stays on until the user turns it off and is hidden when the administrator disables it", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto("/assistant");
  const composer = page.getByRole("textbox", { name: "Message Helix AI" });
  await expect(page.getByRole("button", { name: "Turn off web search" })).toHaveCount(0);
  await page.getByRole("button", { name: "More composer options" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Search" })).not.toBeChecked();
  await page.getByRole("menuitemcheckbox", { name: "Search" }).click();
  await expect(page.getByRole("button", { name: "Turn off web search" })).toBeVisible();
  await composer.fill("Search the web for this topic");
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  expect(backend.requests[0]).toMatchObject({ webSearch: true });
  await expect(page.getByRole("button", { name: "Turn off web search" })).toBeVisible();
  await composer.fill("A follow-up that still needs the web");
  await composer.press("Enter");
  await expect.poll(() => backend.requests.length).toBe(2);
  expect(backend.requests[1]).toMatchObject({ webSearch: true });
  await page.getByRole("button", { name: "Turn off web search" }).click();
  await expect(page.getByRole("button", { name: "Turn off web search" })).toHaveCount(0);
  await page.unroute("**/api/**");
  await mockBackend(page, false, false);
  await page.reload();
  await page.getByRole("button", { name: "More composer options" }).click();
  await expect(page.getByRole("menuitem", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Search" })).toHaveCount(0);
});

test("selects authorized tool groups, retains choices through failures and reopens thin sources and outcomes", async ({
  page,
}) => {
  const backend = await mockBackend(page, true);
  backend.toolsFail = true;
  await page.goto("/assistant");
  await page.getByRole("button", { name: "More composer options" }).click();
  await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "Could not load tools. Retry" })).toBeVisible();
  backend.toolsFail = false;
  await page.getByRole("menuitem", { name: "Could not load tools. Retry" }).click();
  await page.getByRole("button", { name: "More composer options" }).click();
  await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
  await expect(page.getByRole("menuitemcheckbox", { name: "Mail (8)" })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Admin (3)" })).not.toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Calendar (0)" })).toHaveCount(0);
  await page.getByRole("menuitemcheckbox", { name: "Drive (4)" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Workspace search and other tools (1)" })
    .click();
  await page.getByRole("menuitemcheckbox", { name: "Admin (3)" }).click();
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (await (window as typeof window & { axe: typeof axe }).axe.run(document)).violations,
  );
  expect(violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const composer = page.getByRole("textbox", { name: "Message Helix AI" });
  await composer.fill("Review tools and sources");
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Provider is busy");
  await composer.press("Enter");
  await expect(page.getByRole("list", { name: "Sources" })).toContainText("weather.example");
  await expect(page.getByRole("button", { name: "Evidence" })).toBeVisible();
  expect(backend.requests).toEqual([
    expect.objectContaining({ toolGroups: ["mail", "admin"] }),
    expect.objectContaining({ toolGroups: ["mail", "admin"] }),
  ]);
  await expect(page.getByText("Tool failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Tool activity" })).toContainText("Completed");
  await expect(page.getByRole("list", { name: "Tool activity" })).toContainText("Page unavailable");
  await expect(page.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "Evidence" }).click();
  const evidence = page.getByRole("dialog", { name: "Evidence" });
  await expect(evidence.getByRole("link")).toHaveCount(2);
  await expect(evidence.getByRole("link", { name: "Forecast page read" })).toHaveAttribute(
    "href",
    "https://weather.example/forecast",
  );
  await expect(evidence).not.toContainText("Read page");
  await page.getByRole("button", { name: "More composer options" }).click();
  await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
  await expect(page.getByRole("menuitemcheckbox", { name: "Mail (8)" })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Admin (3)" })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Drive (4)" })).not.toBeChecked();
});

test("quick prompts respect an explicitly empty workspace tool selection", async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto("/assistant");
  await page.getByRole("button", { name: "More composer options" }).click();
  await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Mail (8)" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Drive (4)" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Workspace search and other tools (1)" })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Catch me up on mail Summarize unread threads" }).click();
  await expect.poll(() => backend.requests.length).toBe(1);
  expect(backend.requests[0]).toMatchObject({ toolGroups: [] });
});

test("plain-text persisted answers have a stable conversation heading", async ({ page }) => {
  const backend = await mockBackend(page);
  backend.conversations[conversationId] = [
    { id: userMessageId, role: "user", content: "Find sources" },
    {
      id: "answer",
      role: "assistant",
      content: "A plain answer without a Markdown heading.",
      sources,
      toolActivity,
    },
  ];
  await page.goto(`/assistant?conversation=${conversationId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Helix AI conversation" })).toHaveCount(
    1,
  );
  await expect(page.getByRole("list", { name: "Sources" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Evidence" })).toBeVisible();
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(
      async () =>
        (await (window as typeof window & { axe: typeof axe }).axe.run(document)).violations,
    ),
  ).toEqual([]);
});

for (const width of [390, 768, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Assistant messages and composer are accessible at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(
        (theme) =>
          localStorage.setItem(
            "helix-appearance",
            JSON.stringify({ theme, density: "compact", accent: "#7c3aed", fontScale: "default" }),
          ),
        theme,
      );
      await mockBackend(page);
      await page.goto(`/assistant?conversation=${conversationId}`);
      await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
      await expect(page.getByRole("table")).toContainText("80°F");
      await expect(page.getByRole("columnheader", { name: "Element" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Response table" })).toHaveAttribute(
        "tabindex",
        "0",
      );
      await expect(page.getByRole("combobox", { name: "Assistant model" })).toHaveValue(
        models[0]?.id ?? "",
      );
      const modelBox = await page.getByRole("combobox", { name: "Assistant model" }).boundingBox();
      const sendBox = await page
        .getByRole("button", { name: "Send message", exact: true })
        .boundingBox();
      expect(modelBox?.width).toBeLessThanOrEqual(208);
      expect(Math.abs((modelBox?.y ?? 0) - (sendBox?.y ?? 0))).toBeLessThan(10);
      const disclaimer = page.getByText(
        "Helix AI may produce inaccurate information. Verify important details.",
        { exact: true },
      );
      await expect(disclaimer).toHaveCount(1);
      expect((await disclaimer.boundingBox())?.y).toBeGreaterThan(sendBox?.y ?? 0);
      await page.addScriptTag({ content: axe.source });
      await page.getByRole("button", { name: "More composer options" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Search" }).click();
      await expect(page.getByRole("button", { name: "Turn off web search" })).toBeVisible();
      for (const menuOpen of [false, true]) {
        if (menuOpen) await page.getByRole("button", { name: "More composer options" }).click();
        const violations = await page.evaluate(
          async () =>
            (
              await (window as typeof window & { axe: typeof axe }).axe.run(document, {
                runOnly: {
                  type: "tag",
                  values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
                },
              })
            ).violations,
        );
        expect(violations).toEqual([]);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      ).toBe(false);
    });
  }
}

async function mockBackend(page: Page, failFirst = false, webSearchEnabled = true) {
  await seedBrowserSession(page, "assistant-essentials-session");
  const state = {
    conversations: { [conversationId]: savedMessages } as Record<string, unknown[]>,
    toolsFail: false,
    clean: false,
    quarantined: false,
    requests: [] as unknown[],
    uploads: 0,
    puts: 0,
    finalizations: 0,
    remoteRequests: 0,
  };
  await page.route("https://untrusted.example/**", async (route) => {
    state.remoteRequests += 1;
    await route.abort();
  });
  await page.route("**/assistant-upload", async (route) => {
    state.puts += 1;
    await route.fulfill({ status: 200 });
  });
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/assistant.tools.list"))
      return state.toolsFail
        ? fulfillJson(route, { error: { message: "Tools temporarily unavailable" } }, 503)
        : fulfillJson(route, { groups });
    if (pathname.endsWith("/assistant.models.list"))
      return fulfillJson(route, { models, defaultModelId: models[0]?.id, webSearchEnabled });
    if (pathname.endsWith("/assistant.conversations.list"))
      return fulfillJson(route, { items: [], nextCursor: null });
    if (pathname.endsWith("/assistant.conversation.get")) {
      const input = route.request().postDataJSON() as { conversationId: string };
      return fulfillJson(route, {
        conversation: { id: input.conversationId },
        messages: state.conversations[input.conversationId],
      });
    }
    if (pathname.endsWith("/drive.upload")) {
      state.uploads += 1;
      return fulfillJson(route, {
        ...attachment,
        status: "pending_upload",
        uploadUrl: new URL("/assistant-upload", route.request().url()).href,
        uploadHeaders: {},
      });
    }
    if (pathname.endsWith("/drive.finalize")) {
      state.finalizations += 1;
      return fulfillJson(route, {});
    }
    if (pathname.endsWith("/drive.upload.status"))
      return fulfillJson(route, {
        objectId,
        state: state.quarantined ? "quarantined" : state.clean ? "active" : "scanning",
        label: state.clean ? "Ready" : "Scanning",
        available: state.clean,
        terminal: state.clean || state.quarantined,
        updatedAt: new Date().toISOString(),
      });
    if (pathname.endsWith("/assistant.chat")) {
      state.requests.push(route.request().postDataJSON());
      if (failFirst && state.requests.length === 1)
        return fulfillJson(route, { error: { message: "Provider is busy. Try again." } }, 429);
      const input = route.request().postDataJSON() as {
        editMessageId?: string;
        message: string;
        attachmentObjectIds?: string[];
        toolGroups?: string[];
        webSearch?: boolean;
      };
      const targetId = input.editMessageId === undefined ? conversationId : branchId;
      const messages =
        input.editMessageId === undefined
          ? savedMessages.map((message) =>
              message.role === "user"
                ? {
                    ...message,
                    content: input.message,
                    toolGroups: input.toolGroups,
                    webSearch: input.webSearch,
                  }
                : message,
            )
          : [
              {
                id: "50000000-0000-4000-8000-000000000001",
                role: "user",
                content: input.message,
                toolGroups: input.toolGroups,
                webSearch: input.webSearch,
                attachments: input.attachmentObjectIds?.includes(objectId) ? [attachment] : [],
              },
              { id: "60000000-0000-4000-8000-000000000001", role: "assistant", content: markdown },
            ];
      state.conversations[targetId] = messages;
      const turn = {
        conversation: { id: targetId },
        response: { content: markdown },
        messages,
      };
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "delta", text: "# Review" })}\n\ndata: ${JSON.stringify({ type: "final", turn })}\n\n`,
      });
    }
    return fulfillJson(route, {});
  });
  return state;
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
