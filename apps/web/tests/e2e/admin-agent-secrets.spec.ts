import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

/* Admin → Agent secrets: an administrator stores a secret, chooses whether
   agents use it without seeing it or are handed it, and grants it to agents.
   The value goes to the server once and never comes back. */

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Uses a fixed set of agents the live backend does not have."),
);

const DEPLOY_BOT = agent(1, "Deploy bot");
const REPORTING = agent(2, "Reporting", { type: "service_account" });
const RETIRED = agent(3, "Retired bot", { disabled: true });

function agent(index: number, displayName: string, fields: Record<string, unknown> = {}) {
  return {
    id: `11111111-1111-4111-8111-11111111111${String(index)}`,
    displayName,
    type: "agent",
    description: "",
    disabled: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...fields,
  };
}

function grant(holder: { id: string; displayName: string; type: string }, useCount = 0) {
  return {
    actorId: holder.id,
    displayName: holder.displayName,
    actorType: holder.type,
    disabled: false,
    grantedAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: useCount === 0 ? null : "2026-08-02T00:00:00.000Z",
    useCount,
  };
}

interface StoredSecret {
  id: string;
  name: string;
  description: string;
  mode: "use_only" | "handover";
  allowedHosts: string[];
  headerName: string;
  headerPrefix: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string;
  grants: ReturnType<typeof grant>[];
}

const PORTAL: StoredSecret = {
  id: "22222222-2222-4222-8222-222222222221",
  name: "portal-password",
  description: "Supplier portal",
  mode: "handover",
  allowedHosts: [],
  headerName: "authorization",
  headerPrefix: "Bearer ",
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  rotatedAt: "2026-08-01T00:00:00.000Z",
  grants: [grant(DEPLOY_BOT, 4)],
};

interface Vault {
  secrets: StoredSecret[];
  created: unknown[];
  updates: unknown[];
  grantChanges: unknown[];
  deleted: string[];
  /** True once the organization asks for a second administrator's approval. */
  grantsNeedSecondAdministrator: boolean;
  unattended: boolean;
  settingUpdates: unknown[];
}

const holders = (ids: readonly string[]) =>
  [DEPLOY_BOT, REPORTING].filter((candidate) => ids.includes(candidate.id)).map((it) => grant(it));

async function openAgentSecrets(page: Page): Promise<Vault> {
  const vault: Vault = {
    secrets: [structuredClone(PORTAL)],
    created: [],
    updates: [],
    grantChanges: [],
    deleted: [],
    grantsNeedSecondAdministrator: false,
    unattended: true,
    settingUpdates: [],
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname === "/v1/api/admin/tenant-config") {
      if (method === "PATCH") {
        const update = request.postDataJSON() as {
          features: { agent_secrets_unattended: boolean };
        };
        vault.settingUpdates.push(update);
        vault.unattended = update.features.agent_secrets_unattended;
      }
      const features = { agent_secrets_unattended: vault.unattended };
      return route.fulfill({
        json: {
          tenantConfig: {
            orgId: "33333333-3333-4333-8333-333333333333",
            orgName: "Example",
            byo: {},
            features: {},
            quotas: {},
            branding: {},
            effective: { byo: {}, features, quotas: {}, branding: {} },
          },
        },
      });
    }
    if (pathname === "/v1/api/admin/agents") {
      return route.fulfill({ json: { agents: [DEPLOY_BOT, REPORTING, RETIRED] } });
    }
    if (pathname === "/v1/api/admin/agent-secrets" && method === "GET") {
      return route.fulfill({ json: { secrets: vault.secrets } });
    }
    if (pathname === "/v1/api/admin/agent-secrets" && method === "POST") {
      const body = request.postDataJSON() as StoredSecret & { value: string };
      vault.created.push(body);
      // Like the server, keep everything about the secret except its value.
      const secret = {
        ...PORTAL,
        ...body,
        id: "22222222-2222-4222-8222-222222222222",
        grants: [],
      } as StoredSecret & { value?: string };
      delete secret.value;
      vault.secrets.push(secret);
      return route.fulfill({ status: 201, json: { secret } });
    }
    const [, id, grants] = /\/agent-secrets\/([^/]+)(\/grants)?$/u.exec(pathname) ?? [];
    const secret = vault.secrets.find((candidate) => candidate.id === id);
    if (secret === undefined) return route.fulfill({ json: {} });
    if (grants !== undefined && method === "PUT") {
      const body = request.postDataJSON() as { actorIds: string[] };
      vault.grantChanges.push({ id, ...body });
      if (vault.grantsNeedSecondAdministrator) {
        return route.fulfill({
          status: 202,
          json: { code: "crown_jewel_approval_required", approval: { id: "approval-1" } },
        });
      }
      secret.grants = holders(body.actorIds);
      return route.fulfill({ json: { secret } });
    }
    if (method === "PATCH") {
      const body = request.postDataJSON() as Partial<StoredSecret> & { value?: string };
      vault.updates.push({ id, ...body });
      // The server's rule: a use-only secret is not repointed without its value.
      if (
        secret.mode === "use_only" &&
        body.allowedHosts !== undefined &&
        body.value === undefined
      ) {
        return route.fulfill({
          status: 400,
          json: {
            error:
              "Enter the value again to change where a use-only secret is sent or who can read it.",
            code: "invalid_request",
          },
        });
      }
      const { value, ...changes } = body;
      Object.assign(secret, changes, value === undefined ? {} : { version: secret.version + 1 });
      return route.fulfill({ json: { secret } });
    }
    if (method === "DELETE") {
      vault.deleted.push(secret.id);
      vault.secrets = vault.secrets.filter((candidate) => candidate.id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/agent-secrets");
  return vault;
}

async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
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

test("stores a use-only secret for chosen agents and never shows its value again", async ({
  page,
}) => {
  const vault = await openAgentSecrets(page);
  const stored = page.getByRole("list", { name: "Stored secrets" });
  await expect(stored.getByRole("listitem")).toHaveCount(1);
  await expect(stored).toContainText("portal-password");
  await expect(stored).toContainText("Handed to the agent");
  await expect(stored).toContainText("Granted to Deploy bot.");

  const form = page.getByRole("region", { name: "Add a secret" });
  // A disabled agent cannot be given a new secret.
  await expect(form.getByRole("checkbox")).toHaveCount(2);
  await form.getByLabel("Name").fill("billing-api");
  await form.getByLabel("What it is for").fill("Billing provider");
  await form.getByLabel("Value", { exact: true }).fill("tok_live_abc123");
  await expect(form.getByRole("radio", { name: /^Use only/u })).toBeChecked();
  await form.getByLabel("Hosts it may be sent to").fill("API.example.com, uploads.example.com");
  await form.getByRole("checkbox", { name: "Reporting (service account)" }).check();
  await expect(form).toContainText("Agents that may use it (1 chosen)");
  await audit(page);

  await form.getByRole("button", { name: "Store secret" }).click();
  await expect(stored.getByRole("listitem")).toHaveCount(2);
  await expect(stored).toContainText("Sent to api.example.com, uploads.example.com.");
  await expect(stored).toContainText("Granted to Reporting.");
  expect(vault.created).toEqual([
    {
      name: "billing-api",
      description: "Billing provider",
      mode: "use_only",
      value: "tok_live_abc123",
      allowedHosts: ["api.example.com", "uploads.example.com"],
      headerName: "authorization",
      headerPrefix: "Bearer ",
    },
  ]);
  // Granting is a request of its own, and it carries no value.
  expect(vault.grantChanges).toEqual([
    { id: "22222222-2222-4222-8222-222222222222", actorIds: [REPORTING.id] },
  ]);
  // The form is cleared and the value appears nowhere on the page.
  await expect(form.getByLabel("Value", { exact: true })).toHaveValue("");
  await expect(page.getByText("tok_live_abc123")).toHaveCount(0);

  // Repointing a use-only secret is refused until the value is entered again.
  await stored.getByRole("button", { name: "Edit billing-api" }).click();
  const edit = page.getByRole("region", { name: "Edit billing-api" });
  await expect(edit.getByLabel("Name")).toBeDisabled();
  await edit.getByLabel("Hosts it may be sent to").fill("evil.example.net");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit.getByRole("alert")).toContainText("Enter the value again");
  await edit.getByLabel("New value").fill("tok_live_new");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(stored).toContainText("Sent to evil.example.net.");
  expect(vault.updates.at(-1)).toEqual({
    id: "22222222-2222-4222-8222-222222222222",
    allowedHosts: ["evil.example.net"],
    value: "tok_live_new",
  });
});

test("keeps a stored secret and says so when granting waits for a second administrator", async ({
  page,
}) => {
  const vault = await openAgentSecrets(page);
  vault.grantsNeedSecondAdministrator = true;
  const stored = page.getByRole("list", { name: "Stored secrets" });
  const form = page.getByRole("region", { name: "Add a secret" });
  await form.getByLabel("Name").fill("billing-api");
  await form.getByLabel("Value", { exact: true }).fill("tok_live_abc123");
  await form.getByLabel("Hosts it may be sent to").fill("api.example.com");
  await form.getByRole("checkbox", { name: "Deploy bot" }).check();
  await form.getByRole("button", { name: "Store secret" }).click();

  await expect(stored.getByRole("listitem")).toHaveCount(2);
  await expect(stored).toContainText("No agent can use it yet.");
  const notice = page.getByRole("region", { name: "Stored secrets" }).getByRole("alert");
  await expect(notice).toContainText("billing-api was saved, but who can use it was not changed.");
  await expect(notice).toContainText("A second administrator must approve this change");
  await expect(notice).toContainText("under Admin → Policies");
  await expect(form.getByLabel("Value", { exact: true })).toHaveValue("");
  await audit(page);
});

test("changes who holds a secret and deletes one after confirming", async ({ page }) => {
  const vault = await openAgentSecrets(page);
  const stored = page.getByRole("list", { name: "Stored secrets" });

  await stored.getByRole("button", { name: "Edit portal-password" }).click();
  const edit = page.getByRole("region", { name: "Edit portal-password" });
  await expect(edit.getByRole("checkbox", { name: "Deploy bot" })).toBeChecked();
  await edit.getByRole("checkbox", { name: "Deploy bot" }).uncheck();
  await edit.getByRole("checkbox", { name: "Reporting (service account)" }).check();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(stored).toContainText("Granted to Reporting.");
  // Only the grants changed, so nothing else about the secret is sent.
  expect(vault.updates).toEqual([]);
  expect(vault.grantChanges).toEqual([{ id: PORTAL.id, actorIds: [REPORTING.id] }]);

  await stored.getByRole("button", { name: "Delete portal-password" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete portal-password" });
  await expect(dialog).toContainText("Reporting will no longer be able to use it.");
  await audit(page);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("No secrets yet. Add the first one below.")).toBeVisible();
  expect(vault.deleted).toEqual([PORTAL.id]);
});

test("lets the organization ask for a person to confirm each request", async ({ page }) => {
  const vault = await openAgentSecrets(page);
  const unattended = page
    .getByRole("region", { name: "Requests agents make with a secret" })
    .getByRole("switch", { name: "Agents send use-only secrets without asking a person" });
  // Unattended unless the organization says otherwise.
  await expect(unattended).toBeChecked();
  await unattended.click();
  await expect(unattended).not.toBeChecked();
  expect(vault.settingUpdates).toEqual([
    {
      features: { agent_secrets_unattended: false },
      reason: "admin settings update: agent_secrets_unattended",
    },
  ]);
  await audit(page);
});
