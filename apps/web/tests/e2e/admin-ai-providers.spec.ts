import axe from "axe-core";
import { expect, test } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import type {
  PlatformConfigPatch,
  PlatformConfigStatus,
} from "../../src/features/admin/tier-readiness/types";

test("AI provider table edits models, retains failed drafts and keeps credentials write-only", async ({
  page,
}) => {
  let status: PlatformConfigStatus = {
    config: {
      security: { tier: "business" },
      ai: {
        providers: [
          {
            id: "chat",
            plugin: "openai-compat",
            enabled: true,
            config: {
              displayName: "Chat provider",
              baseUrl: "https://llm.example/v1",
              defaultModel: "model-a",
              models: ["model-a"],
              apiKeyConfigured: true,
            },
          },
          {
            id: "backup",
            plugin: "openai-compat",
            enabled: true,
            config: { displayName: "Backup", defaultModel: "model-b", models: ["model-b"] },
          },
        ],
      },
    },
    readiness: { ready: true, requirements: [] },
  };
  const patches: PlatformConfigPatch[] = [];
  let reject = true;
  await page.addInitScript(() => localStorage.setItem("helix.accessToken", "e2e-admin"));
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    if (new URL(route.request().url()).pathname.endsWith("/admin/platform-config")) {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as PlatformConfigPatch;
        patches.push(patch);
        if (reject) {
          reject = false;
          await route.fulfill({ status: 503, json: { error: "Temporary save failure" } });
          return;
        }
        status = {
          ...status,
          config: { ...status.config, ai: { ...status.config.ai, ...patch.ai } },
        };
      }
      await route.fulfill({ json: status });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto("/admin/assistant?tab=models");
  const table = page.getByRole("table", { name: "AI providers", exact: true });
  await expect(table).toContainText("Chat provider");
  await page.screenshot({ path: test.info().outputPath("provider-table.png") });
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await table.getByRole("button", { name: "Provider", exact: true }).click();
  await expect(table.locator("tbody tr").first()).toContainText("Backup");
  await page.getByRole("searchbox", { name: "Search providers" }).fill("model-a");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit provider chat", exact: true }).click();
  const panel = page.getByRole("dialog");
  await expect(panel).not.toHaveAttribute("aria-modal", "true");
  await expect(panel.getByLabel("Provider ID", { exact: true })).toBeDisabled();
  await panel.getByLabel("Display name", { exact: true }).fill("Updated provider");
  await panel.getByRole("textbox", { name: "Model ID", exact: true }).fill("model-new");
  await panel.getByRole("button", { name: "Add model" }).click();
  await panel
    .getByRole("combobox", { name: "Default model", exact: true })
    .selectOption("model-new");
  await page.screenshot({ path: test.info().outputPath("provider-panel.png") });
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((item) => item.id),
    ),
  ).toEqual([]);
  await panel.getByRole("button", { name: "Save provider" }).click();
  await expect(panel).toContainText("Temporary save failure");
  await expect(panel.getByLabel("Display name", { exact: true })).toHaveValue("Updated provider");
  await panel.getByRole("button", { name: "Save provider" }).click();
  await expect(panel).toHaveCount(0);
  expect(patches[1]?.ai?.providers?.[0]?.config).toMatchObject({
    defaultModel: "model-new",
    models: ["model-new", "model-a"],
  });
  expect(patches[1]?.ai?.providers?.[0]?.config?.apiKey).toBeUndefined();
  await expect(table).toContainText("Updated provider");
});

test("meeting transcription and summaries select independent providers without enabling capture", async ({
  page,
}) => {
  let status: PlatformConfigStatus = {
    config: {
      security: { tier: "business" },
      ai: {
        providers: [
          {
            id: "speech",
            plugin: "openai-compat",
            enabled: true,
            config: {
              displayName: "Speech",
              baseUrl: "https://speech.example/v1",
              realtimeTranscription: true,
              defaultModel: "speech-a",
              models: ["speech-a", "speech-b"],
              apiKeyConfigured: true,
            },
          },
          {
            id: "text",
            plugin: "anthropic-compatible",
            enabled: true,
            config: {
              displayName: "Text",
              baseUrl: "https://api.anthropic.com/v1",
              defaultModel: "text-a",
              models: ["text-a", "text-b"],
              apiKeyConfigured: true,
            },
          },
        ],
      },
    },
    readiness: { ready: true, requirements: [] },
  };
  const patches: PlatformConfigPatch[] = [];
  await page.addInitScript(() => localStorage.setItem("helix.accessToken", "e2e-admin"));
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    if (new URL(route.request().url()).pathname.endsWith("/admin/platform-config")) {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as PlatformConfigPatch;
        patches.push(patch);
        status = {
          ...status,
          config: { ...status.config, ai: { ...status.config.ai, ...patch.ai } },
        };
      }
      await route.fulfill({ json: status });
    } else await route.fulfill({ json: {} });
  });
  await page.goto("/admin/assistant?tab=models");
  const speech = page.getByRole("combobox", {
    name: "Meeting transcription provider",
    exact: true,
  });
  const recap = page.getByRole("combobox", { name: "Meeting summaries provider", exact: true });
  await expect(speech).toHaveValue("");
  await expect(recap).toHaveValue("");
  await expect(speech.locator("option")).toHaveText(["— not assigned —", "Speech"]);
  await speech.selectOption("speech");
  await page
    .getByRole("combobox", { name: "Meeting transcription model", exact: true })
    .selectOption("speech-b");
  await recap.selectOption("text");
  await page
    .getByRole("combobox", { name: "Meeting summaries model", exact: true })
    .selectOption("text-b");
  await page.getByRole("button", { name: "Save AI settings", exact: true }).click();
  await expect(page.getByText("Saved. AI settings now apply to new requests.")).toBeVisible();
  expect(patches[0]?.ai?.routing?.rules).toEqual(
    expect.arrayContaining([
      { feature: "meet.transcribe", primary: { providerId: "speech", model: "speech-b" } },
      { feature: "meet.summarize", primary: { providerId: "text", model: "text-b" } },
    ]),
  );
  expect(JSON.stringify(patches)).not.toContain("meet_transcription");
  expect(JSON.stringify(patches)).not.toContain('apiKey"');
  await page.reload();
  await expect(speech).toHaveValue("speech");
  await expect(recap).toHaveValue("text");
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((item) => item.id),
    ),
  ).toEqual([]);
});
