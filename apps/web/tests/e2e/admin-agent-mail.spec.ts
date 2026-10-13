import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

/* Admin → Agent mail: an administrator gives an agent a mail address, says who
   may write to it from outside, and decides what happens to mail that was held
   because the agent's settings did not let it through. */

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Uses a fixed set of agents the live backend does not have."),
);

interface Mailbox {
  id: string;
  displayName: string;
  type: "agent" | "service_account";
  disabled: boolean;
  address: string | null;
  receiveMode: "allowed_senders" | "anyone";
  allowedSenders: string[];
}

function mailbox(index: number, displayName: string, fields: Partial<Mailbox> = {}): Mailbox {
  return {
    id: `11111111-1111-4111-8111-11111111111${String(index)}`,
    displayName,
    type: "agent",
    disabled: false,
    address: null,
    receiveMode: "allowed_senders",
    allowedSenders: [],
    ...fields,
  };
}

function heldMessage(index: number, fromAddress: string, reasons: string) {
  return {
    id: `44444444-4444-4444-8444-44444444444${String(index)}`,
    recipientAddresses: ["billing-bot@example.com"],
    envelopeFrom: `bounce-${String(index)}@mailer.example`,
    fromAddress,
    signature: `agent-mail:${reasons}`,
    status: "pending",
    bytesDeleted: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    resolvedAt: null,
  };
}

interface Desk {
  agents: Mailbox[];
  held: ReturnType<typeof heldMessage>[];
  saves: unknown[];
  released: unknown[];
  deleted: unknown[];
}

async function openAgentMail(page: Page): Promise<Desk> {
  const desk: Desk = {
    agents: [
      mailbox(1, "Billing bot", { address: "billing-bot@example.com" }),
      mailbox(2, "Deploy bot"),
      // Disabled with no address: nothing left to manage, so it is not listed.
      mailbox(3, "Retired bot", { disabled: true }),
    ],
    held: [
      heldMessage(1, "stranger@elsewhere.example", "sender-not-allowed"),
      heldMessage(2, "ana@partner.example", "sender-not-verified,instructs-the-agent"),
      // Quarantined for malware, not by an agent's settings: belongs to another screen.
      { ...heldMessage(3, "virus@elsewhere.example", ""), signature: "Eicar-Test-Signature" },
    ],
    saves: [],
    released: [],
    deleted: [],
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname === "/v1/api/admin/agent-mail") {
      return route.fulfill({ json: { agents: desk.agents, domains: ["example.com"] } });
    }
    const [, agentId] = /\/admin\/agent-mail\/([^/]+)$/u.exec(pathname) ?? [];
    if (agentId !== undefined && method === "PUT") {
      const body = request.postDataJSON() as Pick<
        Mailbox,
        "address" | "receiveMode" | "allowedSenders"
      >;
      desk.saves.push({ id: agentId, ...body });
      if (body.address === "taken@example.com") {
        return route.fulfill({
          status: 409,
          json: {
            error: "That address already belongs to a person, a group or another agent.",
            code: "conflict",
          },
        });
      }
      const agent = desk.agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return route.fulfill({ status: 404, json: {} });
      Object.assign(agent, body);
      return route.fulfill({ json: { agent } });
    }
    if (pathname === "/v1/api/admin/mail/quarantine") {
      return route.fulfill({ json: { quarantines: desk.held } });
    }
    const [, heldId, release] =
      /\/admin\/mail\/quarantine\/([^/]+)(\/release)?$/u.exec(pathname) ?? [];
    if (heldId !== undefined) {
      (release === undefined ? desk.deleted : desk.released).push({
        id: heldId,
        ...(request.postDataJSON() as object),
      });
      desk.held = desk.held.filter((candidate) => candidate.id !== heldId);
      return route.fulfill({ json: { status: release === undefined ? "deleted" : "released" } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/agent-mail");
  return desk;
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

test("gives an agent an address and lists who may write to it from outside", async ({ page }) => {
  const desk = await openAgentMail(page);
  const agents = page.getByRole("list", { name: "Agents" });
  await expect(agents.getByRole("listitem")).toHaveCount(2);
  await expect(agents).toContainText(
    "billing-bot@example.com. Nobody outside can write to it yet.",
  );
  await expect(agents).toContainText("No mail address.");

  await agents.getByRole("button", { name: "Edit mail for Deploy bot" }).click();
  const form = page.getByRole("region", { name: "Mail for Deploy bot" });
  await expect(form.getByRole("radio", { name: /^Only the senders I list/u })).toBeChecked();
  await form.getByLabel("Address", { exact: true }).fill("taken");
  await audit(page);
  await form.getByRole("button", { name: "Save" }).click();
  // A refusal is shown in the form and nothing is lost.
  await expect(form).toContainText("already belongs to a person, a group or another agent");

  await form.getByLabel("Address", { exact: true }).fill("deploy-bot");
  await form
    .getByLabel(/^Allowed senders/u)
    .fill("Ana@Partner.Example\n@supplier.example, ana@partner.example");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(agents).toContainText(
    "deploy-bot@example.com. Outside, only ana@partner.example, @supplier.example can write to it.",
  );
  expect(desk.saves.at(-1)).toEqual({
    id: desk.agents[1]?.id,
    address: "deploy-bot@example.com",
    receiveMode: "allowed_senders",
    allowedSenders: ["ana@partner.example", "@supplier.example"],
  });

  // Opening an agent to everyone needs no list, and blanking the address takes mail away.
  await agents.getByRole("button", { name: "Edit mail for Billing bot" }).click();
  const billing = page.getByRole("region", { name: "Mail for Billing bot" });
  await billing.getByRole("radio", { name: /^Anyone/u }).check();
  await expect(billing.getByLabel(/^Allowed senders/u)).toHaveCount(0);
  await billing.getByLabel("Address", { exact: true }).fill("");
  await billing.getByRole("button", { name: "Save" }).click();
  await expect(billing).toHaveCount(0);
  expect(desk.saves.at(-1)).toEqual({
    id: desk.agents[0]?.id,
    address: null,
    receiveMode: "anyone",
    allowedSenders: [],
  });
});

test("shows held mail with the reason, and delivers or deletes it on confirmation", async ({
  page,
}) => {
  const desk = await openAgentMail(page);
  const held = page.getByRole("list", { name: "Held mail" });
  // Mail quarantined for malware is not an agent-mail decision and is not listed here.
  await expect(held.getByRole("listitem")).toHaveCount(2);
  const stranger = held.getByRole("listitem").filter({ hasText: "stranger@elsewhere.example" });
  await expect(stranger).toContainText("to Billing bot");
  await expect(stranger).toContainText("The sender is not on the agent's list.");
  const ana = held.getByRole("listitem").filter({ hasText: "ana@partner.example" });
  await expect(ana).toContainText("could not prove it came from the sender it names");
  await expect(ana).toContainText("tells the agent to ignore its instructions");
  await audit(page);

  await ana.getByRole("button", { name: /^Deliver/u }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Deliver to Billing bot");
  await expect(dialog).toContainText("the agent may act on what it says");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(desk.released).toEqual([]);

  await ana.getByRole("button", { name: /^Deliver/u }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Deliver" }).click();
  await expect(held.getByRole("listitem")).toHaveCount(1);
  expect(desk.released).toEqual([
    {
      id: "44444444-4444-4444-8444-444444444442",
      reason: "Delivered to the agent from Admin → Agent mail.",
      confirmed: true,
    },
  ]);

  await stranger.getByRole("button", { name: /^Delete/u }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Nothing is held.")).toBeVisible();
  expect(desk.deleted).toEqual([
    {
      id: "44444444-4444-4444-8444-444444444441",
      reason: "Deleted from Admin → Agent mail.",
      confirmed: true,
    },
  ]);
});
