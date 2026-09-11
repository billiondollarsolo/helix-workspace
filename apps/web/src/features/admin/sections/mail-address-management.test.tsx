// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminUserAddressesButton } from "./user-addresses-dialog";
import { GroupMailForm } from "./group-mail-form";
import { createGroup, updateGroup, type Group } from "../groups-api";
import { MailSenderSelect, useMailSender } from "../../mail/mail-sender-select";
import { mailAddressQueryKeys, type MailAddresses } from "@/lib/mail-addresses";
import {
  readMailComposeRecovery,
  writeMailComposeRecovery,
} from "../../mail/mail-compose-recovery";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<object>()),
  authenticatedFetch: fetchMock,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let data: MailAddresses;
const group: Group = {
  id: "g-1",
  orgId: "o-1",
  name: "Support",
  email: "support@second.test",
  kind: "mailing_list",
  postingPolicy: "organization",
  description: "",
  orgUnitId: null,
  memberCount: 1,
  createdAt: "2026-09-01",
  updatedAt: "2026-09-01",
};
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  data = {
    actorId: "user-1",
    primaryEmail: "morgan@first.test",
    loginEmail: "morgan@login.test",
    eligibleDomains: [
      { domain: "first.test", primary: true, aliases: true },
      { domain: "second.test", primary: true, aliases: true },
      { domain: "automatic.test", primary: false, aliases: true },
    ],
    addresses: [
      {
        id: null,
        address: "morgan@first.test",
        displayName: "Morgan",
        isPrimary: true,
        receiveEnabled: true,
        sendAsEnabled: true,
        source: "primary",
      },
      {
        id: null,
        address: "morgan@automatic.test",
        displayName: "Morgan",
        isPrimary: false,
        receiveEnabled: true,
        sendAsEnabled: true,
        source: "domain_alias",
      },
    ],
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(Response.json(data)));
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  window.localStorage.clear();
});
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function render(node: ReactNode) {
  await act(async () => {
    await Promise.resolve();
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  await settle();
}
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const aria = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  if (aria) return aria;
  const element = [...document.querySelectorAll("label")].find(
    (item) =>
      (item.querySelector(".admin-field-label")?.textContent ?? item.textContent)?.trim() === label,
  );
  const input = element?.control;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement))
    throw new Error(`Missing field ${label}`);
  return input;
}
async function fill(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    await Promise.resolve();
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => {
    await Promise.resolve();
    button.click();
  });
  await settle();
}

it("manages aliases and tenant primary across eligible domains, preserves failed drafts and refreshes current sender authority", async () => {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  let fail = true;
  fetchMock.mockImplementation(async (_url, init) => {
    await Promise.resolve();
    const method = init?.method ?? "GET";
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    if (method !== "GET") writes.push({ method, body });
    if (method === "POST") {
      if (fail) {
        fail = false;
        return Response.json(
          { error: { message: "This address belongs to another user." } },
          { status: 409 },
        );
      }
      data = {
        ...data,
        addresses: [
          ...data.addresses,
          {
            id: "alias-1",
            address: String(body.address),
            displayName: null,
            isPrimary: false,
            receiveEnabled: Boolean(body.receiveEnabled),
            sendAsEnabled: Boolean(body.sendAsEnabled),
            source: "alias",
          },
        ],
      };
    }
    if (method === "PATCH")
      data = {
        ...data,
        addresses: data.addresses.map((address) =>
          address.id === "alias-1" ? { ...address, ...body } : address,
        ),
      };
    if (method === "PUT")
      data = {
        ...data,
        primaryEmail: String(body.address),
        addresses: data.addresses.map((address) => ({
          ...address,
          isPrimary: address.address === body.address,
          source:
            address.address === body.address
              ? "primary"
              : address.isPrimary
                ? "alias"
                : address.source,
          id: address.isPrimary ? "former-primary" : address.id,
        })),
      };
    if (method === "DELETE")
      data = {
        ...data,
        addresses: data.addresses.filter((address) => address.id !== "former-primary"),
      };
    return Response.json(data);
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await render(<AdminUserAddressesButton actorId="user-1" name="Morgan" />);
  await click("Mail addresses");
  expect(document.body.textContent).toContain("sign-in email stays unchanged");
  expect(
    [...field("Primary address domain").querySelectorAll("option")].map((item) => item.value),
  ).not.toContain("automatic.test");
  expect(document.querySelector('[aria-label="Remove alias morgan@automatic.test"]')).toBeNull();
  await fill("Alias name", "support");
  await fill("Alias domain", "second.test");
  await act(async () => {
    await Promise.resolve();
    field("Allow sending as this alias").click();
  });
  await click("Add alias");
  expect(document.body.textContent).toContain("This address belongs to another user.");
  expect(field("Alias name").value).toBe("support");
  await click("Add alias");
  expect(field("Alias name").value).toBe("");
  expect(writes[1]).toEqual({
    method: "POST",
    body: { address: "support@second.test", receiveEnabled: true, sendAsEnabled: false },
  });
  await act(async () => {
    await Promise.resolve();
    field("Send as support@second.test").click();
  });
  await settle();
  await act(async () => {
    await Promise.resolve();
    field("Receive mail at support@second.test").click();
  });
  await settle();
  expect(data.addresses.find((address) => address.id === "alias-1")).toMatchObject({
    sendAsEnabled: true,
    receiveEnabled: false,
  });
  await fill("Primary address name", "support");
  await fill("Primary address domain", "second.test");
  await click("Set primary address");
  expect(data.primaryEmail).toBe("support@second.test");
  expect(document.body.textContent).toContain("Primary mail address changed.");
  await act(async () => {
    await Promise.resolve();
    document
      .querySelector<HTMLButtonElement>('[aria-label="Remove alias morgan@first.test"]')
      ?.click();
  });
  await settle();
  expect(data.addresses.some((address) => address.address === "morgan@first.test")).toBe(false);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: mailAddressQueryKeys.current });
  await click("Done");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("retries address lookup failures and rejects malformed successful responses", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { message: "Directory is restarting." } }, { status: 503 }),
  );
  await render(<AdminUserAddressesButton actorId="user-1" name="Morgan" />);
  await click("Mail addresses");
  expect(document.body.textContent).toContain("Directory is restarting.");
  await click("Retry addresses");
  expect(document.body.textContent).toContain("morgan@first.test");
  await click("Done");
  fetchMock.mockResolvedValue(Response.json({ addresses: [] }));
  await act(async () => {
    await Promise.resolve();
    await client.invalidateQueries({ queryKey: mailAddressQueryKeys.byActor("user-1") });
  });
  await click("Mail addresses");
  expect(document.body.textContent).toContain("invalid response");
});

it("creates and edits email groups with explicit sender policy, preserving failed changes", async () => {
  let fail = true;
  const writes: Record<string, unknown>[] = [];
  fetchMock.mockImplementation(async (url, init) => {
    await Promise.resolve();
    if (
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith(
        "/groups/eligible-domains",
      )
    )
      return Response.json(data);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    writes.push(body);
    if (fail) {
      fail = false;
      return Response.json(
        { error: { message: "Group address is already in use." } },
        { status: 409 },
      );
    }
    return Response.json({ group: { ...group, ...body } });
  });
  const saved = vi.fn();
  await render(<GroupMailForm onSave={createGroup} onSaved={saved} />);
  expect(field("Who can email this group?").value).toBe("organization");
  await fill("New group name", "Support");
  await fill("Group email name", "support");
  await fill("Group email domain", "second.test");
  await click("Create group");
  expect(document.body.textContent).toContain("Group address is already in use.");
  expect(field("Group email name").value).toBe("support");
  await fill("Who can email this group?", "anyone");
  await click("Create group");
  expect(writes.at(-1)).toMatchObject({
    email: "support@second.test",
    postingPolicy: "anyone",
    kind: "mailing_list",
  });
  expect(saved).toHaveBeenCalledOnce();
  await render(
    <GroupMailForm
      key="edit"
      group={{ ...group, postingPolicy: "anyone" }}
      onSave={(input) => updateGroup(group.id, input)}
      onSaved={saved}
    />,
  );
  await fill("Who can email this group?", "organization");
  await click("Save group settings");
  expect(writes.at(-1)?.postingPolicy).toBe("organization");
  await fill("Group type", "group");
  expect(document.body.textContent).toContain("stops delivery");
  await click("Save group settings");
  expect(writes.at(-1)).toMatchObject({ email: null, kind: "group" });
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/admin/groups/g-1",
    expect.objectContaining({ method: "PATCH" }),
  );
});

function SenderHarness({ initial }: { readonly initial?: string }) {
  const sender = useMailSender(initial);
  return (
    <>
      <MailSenderSelect sender={sender} disabled={false} />
      <button disabled={!sender.authorized}>Send message</button>
    </>
  );
}
it("retains a chosen sender across primary changes, blocks revoked addresses, and recovers lookup outages", async () => {
  await render(<SenderHarness />);
  expect(field("From address").value).toBe("morgan@first.test");
  await fill("From address", "morgan@automatic.test");
  data = {
    ...data,
    primaryEmail: "morgan@automatic.test",
    addresses: data.addresses.map((address) => ({
      ...address,
      isPrimary: address.source === "domain_alias",
    })),
  };
  await act(async () => {
    await Promise.resolve();
    client.setQueryData(mailAddressQueryKeys.current, data);
  });
  await settle();
  expect(field("From address").value).toBe("morgan@automatic.test");
  data = {
    ...data,
    addresses: data.addresses.map((address) => ({
      ...address,
      sendAsEnabled: address.source !== "domain_alias",
    })),
  };
  await act(async () => {
    await Promise.resolve();
    client.setQueryData(mailAddressQueryKeys.current, data);
  });
  await settle();
  expect(field("From address").value).toBe("morgan@automatic.test");
  expect(document.body.textContent).toContain("(unavailable)");
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { message: "Address lookup unavailable." } }, { status: 503 }),
  );
  await act(async () => {
    await Promise.resolve();
    await client.invalidateQueries({ queryKey: mailAddressQueryKeys.current });
  });
  await settle();
  expect(document.body.textContent).toContain("Address lookup unavailable.");
  await click("Retry sending addresses");
  await fill("From address", "morgan@first.test");
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
});

it("persists the selected From address through local crash recovery", () => {
  writeMailComposeRecovery({
    from: { address: "support@second.test" },
    to: [],
    cc: [],
    bcc: [],
    subject: "Draft",
    bodyText: "",
    attachments: [],
  });
  expect(readMailComposeRecovery()?.from).toEqual({ address: "support@second.test" });
});
