import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

const masterPassword = "native-vault-fixture-password";
const itemPassword = "fixture-password-never-sent-as-plaintext";
interface Stored {
  version: number;
  ciphertext: string;
  updatedAt: string;
}
async function workspace(page: Page) {
  const state = {
    vault: null as Stored | null,
    previous: null as Stored | null,
    refusal: 0,
    writes: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/api/core-apps")
      return route.fulfill({
        json: {
          role: "all-in-one",
          apps: [],
          passwords: { installed: true, enabled: true, native: true, url: null },
        },
      });
    if (path === "/v1/api/passwords/vault") {
      expect(request.headers()["x-helix-vault-owner"]).toBe("00000000-0000-4000-8000-000000000111");
      if (request.method() === "PUT") {
        state.writes.push(request.postData()!);
        if (state.refusal)
          return route.fulfill({
            status: state.refusal,
            json: { error: { message: "fixture refusal" } },
          });
        const body = request.postDataJSON() as { expectedVersion: number; ciphertext: string };
        if (body.expectedVersion !== (state.vault?.version ?? 0))
          return route.fulfill({ status: 409, json: {} });
        state.previous = state.vault;
        state.vault = {
          version: body.expectedVersion + 1,
          ciphertext: body.ciphertext,
          updatedAt: new Date().toISOString(),
        };
        return route.fulfill({ json: { version: state.vault.version } });
      }
      return route.fulfill({ json: { vault: state.vault, previous: state.previous } });
    }
    if (await fulfillCoreAppsRoute(route)) return;
    return route.fulfill({ json: {} });
  });
  // The disposable crypto worker must work under the production WASM restriction.
  await page.route("**/src/features/passwords/vault-worker.ts*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy": "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
      },
    });
  });
  await page.goto("/passwords");
  await expect(page.getByRole("button", { name: "+ Create vault" })).toBeVisible();
  return state;
}
async function create(page: Page) {
  await page.getByLabel("Master password", { exact: true }).fill(masterPassword);
  await page.getByLabel("Confirm master password").fill(masterPassword);
  await page.getByRole("button", { name: "+ Create vault" }).click();
  await expect(page.getByRole("button", { name: "+ New item" })).toBeVisible();
}
async function newItem(page: Page) {
  await page.getByRole("button", { name: "+ New item" }).click();
  await page.getByLabel("Item name", { exact: true }).fill("Atlas fixture login");
  await page.getByLabel("Username", { exact: true }).fill("Atlas");
  await page.getByLabel("Password", { exact: true }).fill(itemPassword);
  await page.getByLabel("Notes", { exact: true }).fill("Unicode café 日本語");
}
async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(
      async () =>
        (
          await (window as typeof window & { axe: typeof axe }).axe.run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"],
            },
          })
        ).violations,
    ),
  ).toEqual([]);
}

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Native vault fixture owns its encrypted storage."),
);
for (const scheme of ["light", "dark"] as const) {
  test(`native vault creates, saves, locks and reopens without plaintext requests (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") await page.setViewportSize({ width: 390, height: 844 });
    const state = await workspace(page);
    await audit(page);
    await create(page);
    await newItem(page);
    await audit(page);
    await page.getByRole("button", { name: "Save item", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Atlas fixture login", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lock vault" }).click();
    await expect(
      page.getByRole("button", { name: "Atlas fixture login", exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("Master password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Check your master password");
    await page.getByLabel("Master password", { exact: true }).fill(masterPassword);
    await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
    await page.getByRole("button", { name: "Atlas fixture login", exact: true }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(itemPassword);
    await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("Unicode café 日本語");
    await page.getByLabel("Notes", { exact: true }).fill("Edited note");
    await page.getByRole("button", { name: "Save item", exact: true }).click();
    await expect(page.getByLabel("Notes", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download previous version" })).toBeVisible();
    expect(state.writes).toHaveLength(3);
    for (const write of state.writes)
      for (const secret of [
        masterPassword,
        itemPassword,
        "Atlas fixture login",
        "Unicode café 日本語",
      ])
        expect(write).not.toContain(secret);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain(itemPassword);
    await audit(page);
    await page.reload();
    await expect(page.getByRole("button", { name: "Unlock vault", exact: true })).toBeVisible();
    await page.getByLabel("Master password", { exact: true }).fill(masterPassword);
    await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Atlas fixture login", exact: true }),
    ).toBeVisible();
  });
}
test("save failures retain one encrypted candidate and retries do not duplicate new items", async ({
  page,
}) => {
  const state = await workspace(page);
  await create(page);
  await newItem(page);
  state.refusal = 503;
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry save" })).toBeEnabled();
  const failed = JSON.parse(state.writes.at(-1)!) as { ciphertext: string };
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(itemPassword);
  state.refusal = 0;
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("button", { name: "Atlas fixture login", exact: true })).toHaveCount(
    1,
  );
  expect(JSON.parse(state.writes.at(-1)!).ciphertext).toBe(failed.ciphertext);
  await page.getByRole("button", { name: "Atlas fixture login", exact: true }).click();
  await page.getByLabel("Notes", { exact: true }).fill("Conflicting edit");
  state.vault!.version++;
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("changed in another tab");
  await expect(page.getByRole("button", { name: "Download unsaved vault" })).toBeEnabled();
  await page.getByRole("button", { name: "Lock vault" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download unsaved vault" })).toBeVisible();
});

test("an identity refusal clears decrypted fields and keeps the encrypted recovery copy", async ({
  page,
}) => {
  const state = await workspace(page);
  await create(page);
  await newItem(page);
  state.refusal = 403;
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("Vault access ended");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download unsaved vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New item" })).toHaveCount(0);
});

test("a stopped worker clears decrypted fields even when no request is pending", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        Object.assign(window, { vaultTestWorker: this });
      }
    };
  });
  await workspace(page);
  await create(page);
  await newItem(page);
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.getByRole("button", { name: "Atlas fixture login", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(itemPassword);
  await page.evaluate(() =>
    (window as typeof window & { vaultTestWorker: Worker }).vaultTestWorker.dispatchEvent(
      new Event("error"),
    ),
  );
  await expect(page.getByRole("alert")).toContainText("Vault processing stopped");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlock vault", exact: true })).toBeVisible();
});
