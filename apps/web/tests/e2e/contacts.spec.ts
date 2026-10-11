/**
 * Contacts app: create, edit, label, import, export, the Email handoff, and
 * the phone layout.
 *
 * MOCKED (default): `/v1/api/**` is answered by an in-memory contacts backend
 * that implements the `contacts.*` tools the UI calls.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

interface MockContact {
  id: string;
  displayName: string;
  givenName: string;
  familyName: string;
  company: string;
  jobTitle: string;
  emails: { type: string; value: string }[];
  phones: { type: string; value: string }[];
  addresses: unknown[];
  birthday: string | null;
  notes: string;
  labels: string[];
  photoDataUrl: string | null;
  starred: boolean;
  memberActorId: string | null;
  updatedAt: string;
  deletedAt: string | null;
}

const SAM_ACTOR = "00000000-0000-4000-8000-000000000111";
let sequence = 0;

function makeContact(fields: Partial<MockContact>): MockContact {
  sequence += 1;
  const merged = {
    givenName: "",
    familyName: "",
    company: "",
    jobTitle: "",
    emails: [],
    phones: [],
    addresses: [],
    birthday: null,
    notes: "",
    labels: [],
    photoDataUrl: null,
    starred: false,
    memberActorId: null,
    updatedAt: "2026-10-01T12:00:00.000Z",
    deletedAt: null,
    ...fields,
  };
  return {
    ...merged,
    id: fields.id ?? `00000000-0000-4000-8000-${String(900 + sequence).padStart(12, "0")}`,
    displayName:
      fields.displayName ??
      ([merged.givenName, merged.familyName].filter(Boolean).join(" ") || merged.company),
  };
}

interface ContactsBackend {
  contacts: MockContact[];
  labels: Set<string>;
  calls: { tool: string; body: Record<string, unknown> }[];
}

async function mockContactsBackend(page: Page): Promise<ContactsBackend> {
  const backend: ContactsBackend = {
    contacts: [
      makeContact({
        givenName: "Sam",
        familyName: "Patel",
        jobTitle: "Engineer",
        company: "Helix",
        emails: [{ type: "work", value: "sam@helix.local" }],
        memberActorId: SAM_ACTOR,
        labels: ["Team"],
      }),
      makeContact({
        givenName: "Ada",
        familyName: "Lovelace",
        emails: [{ type: "home", value: "ada@example.com" }],
        phones: [{ type: "mobile", value: "+44 20 7946 0000" }],
      }),
    ],
    labels: new Set(["Team"]),
    calls: [],
  };
  const labelList = () => {
    const names = new Set([
      ...backend.labels,
      ...backend.contacts.flatMap((entry) => entry.labels),
    ]);
    return [...names].sort().map((name) => ({
      name,
      count: backend.contacts.filter((entry) => entry.labels.includes(name)).length,
    }));
  };
  const tools: Record<string, (body: Record<string, unknown>) => unknown> = {
    "contacts.list": (body) => {
      const list = body.view === "trash" ? [] : backend.contacts;
      return { contacts: list, total: list.length };
    },
    "contacts.get": (body) => ({ contact: backend.contacts.find((entry) => entry.id === body.id) }),
    "contacts.labels.list": () => ({ labels: labelList(), total: backend.contacts.length }),
    "contacts.duplicates.list": () => ({ groups: [] }),
    "contacts.directory.list": () => ({ members: [], total: 0 }),
    "contacts.create": (body) => {
      const created = makeContact(body);
      backend.contacts.push(created);
      return { contact: created };
    },
    "contacts.update": (body) => {
      const { id, ...patch } = body;
      const index = backend.contacts.findIndex((entry) => entry.id === id);
      const updated = makeContact({
        ...backend.contacts[index],
        ...(patch as Partial<MockContact>),
        displayName: undefined,
      });
      backend.contacts[index] = updated;
      return { contact: updated };
    },
    "contacts.label.create": (body) => {
      backend.labels.add(String(body.name));
      return { label: { name: body.name, count: 0 } };
    },
    "contacts.label.apply": (body) => {
      const ids = body.ids as string[];
      for (const entry of backend.contacts) {
        if (!ids.includes(entry.id)) continue;
        entry.labels = [
          ...entry.labels.filter((label) => !(body.remove as string[]).includes(label)),
          ...(body.add as string[]).filter((label) => !entry.labels.includes(label)),
        ];
      }
      return { contacts: [], total: 0 };
    },
    "contacts.import": (body) => {
      if (body.dryRun === true) {
        return { count: 1, skipped: 0, problems: [], sample: ["Grace Hopper"], imported: false };
      }
      backend.contacts.push(
        makeContact({
          givenName: "Grace",
          familyName: "Hopper",
          labels: typeof body.label === "string" ? [body.label] : [],
        }),
      );
      return { count: 1, skipped: 0, problems: [], sample: [], imported: true };
    },
    "contacts.export": (body) => {
      const ids = (body.ids as string[] | undefined) ?? backend.contacts.map((entry) => entry.id);
      return {
        filename: "contacts.vcf",
        vcard: ids.map((id) => `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${id}\r\nEND:VCARD\r\n`).join(""),
        count: ids.length,
      };
    },
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const url = new URL(route.request().url());
    const tool = /^\/v1\/api\/tools\/(.+)$/u.exec(url.pathname)?.[1];
    if (tool !== undefined && tools[tool] !== undefined) {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      backend.calls.push({ tool, body });
      await fulfillJson(route, tools[tool](body));
      return;
    }
    await fulfillJson(route, {});
  });
  return backend;
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

test.describe("Contacts", () => {
  test.skip(isLiveBackend(), "Mocked contacts backend");

  test.beforeEach(async ({ page }) => {
    await seedBrowserSession(page, "e2e-contacts-token");
  });

  test("creates a contact and edits it", async ({ page }) => {
    const backend = await mockContactsBackend(page);
    await page.goto("/contacts");
    await expect(page.getByRole("heading", { name: "Contacts (2)" })).toBeVisible();

    await page.getByRole("button", { name: "Create contact" }).first().click();
    await page.getByRole("textbox", { name: "First name" }).fill("Grace");
    await page.getByRole("textbox", { name: "Last name" }).fill("Hopper");
    await page.getByRole("textbox", { name: "Email 1" }).fill("grace@example.org");
    await page.getByRole("combobox", { name: "Email 1 type" }).selectOption("work");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("heading", { name: "Grace Hopper" })).toBeVisible();
    expect(backend.calls.find((call) => call.tool === "contacts.create")?.body).toMatchObject({
      givenName: "Grace",
      familyName: "Hopper",
      emails: [{ type: "work", value: "grace@example.org" }],
    });

    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("textbox", { name: "Job title" }).fill("Rear Admiral");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Rear Admiral")).toBeVisible();
    expect(backend.calls.find((call) => call.tool === "contacts.update")?.body).toMatchObject({
      jobTitle: "Rear Admiral",
    });
  });

  test("creates a label and files contacts under it", async ({ page }) => {
    const backend = await mockContactsBackend(page);
    await page.goto("/contacts");
    await page.getByRole("button", { name: "Create label" }).click();
    await page.getByRole("textbox", { name: "Label name" }).fill("Family");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("navigation", { name: "Labels" }).getByText("Family"),
    ).toBeVisible();

    await page.getByRole("checkbox", { name: "Select Ada Lovelace" }).check();
    await page.getByRole("button", { name: "Manage labels" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Family" }).click();
    await expect
      .poll(() => backend.contacts.find((entry) => entry.givenName === "Ada")?.labels)
      .toEqual(["Family"]);

    await page.keyboard.press("Escape");
    await page
      .getByRole("navigation", { name: "Labels" })
      .getByRole("button", { name: /^Family/u })
      .click();
    await expect(page).toHaveURL(/label=Family/u);
    await expect(page.getByRole("heading", { name: "Family (1)" })).toBeVisible();
  });

  test("imports a vCard file after a preview", async ({ page }) => {
    const backend = await mockContactsBackend(page);
    await page.goto("/contacts");
    await page.getByRole("button", { name: "Import" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "contacts.vcf",
      mimeType: "text/vcard",
      buffer: Buffer.from("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Grace Hopper\r\nEND:VCARD\r\n"),
    });
    await expect(page.getByText("1 contact is ready to import.")).toBeVisible();
    await page.getByRole("button", { name: "Import 1" }).click();

    await expect(page.getByText("Imported 1 contact")).toBeVisible();
    await expect(page).toHaveURL(/label=Imported/u);
    expect(
      backend.calls
        .filter((call) => call.tool === "contacts.import")
        .map((call) => call.body.dryRun),
    ).toEqual([true, false]);
  });

  test("exports the selection as a vCard download", async ({ page }) => {
    await mockContactsBackend(page);
    await page.goto("/contacts");
    await page.getByRole("checkbox", { name: "Select all contacts" }).check();
    const download = page.waitForEvent("download");
    await page
      .getByRole("toolbar", { name: "Selected contacts" })
      .getByRole("button", { name: "Export" })
      .click();
    expect((await download).suggestedFilename()).toBe("contacts.vcf");
    await expect(page.getByText("2 contacts exported")).toBeVisible();
  });

  test("hands off to Mail compose and Chat from a contact", async ({ page }) => {
    await mockContactsBackend(page);
    await page.goto("/contacts");
    await page.getByRole("row", { name: /Sam Patel/u }).click();
    await expect(page.getByRole("heading", { name: "Sam Patel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();

    await page
      .getByRole("list", { name: "Contact actions" })
      .getByRole("button", { name: "Email" })
      .click();
    await expect(page).toHaveURL(/\/mail\?compose=new&to=sam%40helix\.local/u);
    const compose = page.getByRole("dialog", { name: "New message" });
    await expect(compose.getByRole("list", { name: "To recipients" })).toContainText(
      "sam@helix.local",
    );
  });

  test("works as a list, then a full-screen contact, on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockContactsBackend(page);
    await page.goto("/contacts");
    await expect(page.getByRole("button", { name: "Create contact" }).last()).toBeVisible();

    await page.getByRole("row", { name: /Ada Lovelace/u }).click();
    await expect(page.getByRole("heading", { name: "Ada Lovelace" })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to contacts" }).click();
    await expect(page.getByRole("heading", { name: "Contacts (2)" })).toBeVisible();

    const box = await page.locator(".contacts-scroll").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  });
});
