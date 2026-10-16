// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { axeViolations, click, key, press, settle, unmountAll } from "@/test/ui";
import type { MailLabelSummary } from "../api";
import {
  LabelColorMenu,
  MailDialogsHost,
  ManageLabelsPage,
  openLabelDialog,
  type MailLabelDialogRequest,
} from "./index";
import {
  buttonNamed,
  choose,
  control,
  dialogNamed,
  renderSettings,
  typeInto,
  waitFor,
} from "./test-support";

const api = vi.hoisted(() => ({
  listMailLabels: vi.fn(),
  createMailLabel: vi.fn(),
  updateMailLabel: vi.fn(),
  deleteMailLabel: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));

function label(id: string, name: string, parentId: string | null = null): MailLabelSummary {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    color: "#636363",
    colorName: "gray",
    parentId,
    sortOrder: 100,
    threadCount: id === "clients" ? 3 : 0,
    unreadCount: 0,
    shared: false,
  };
}

const clients = label("clients", "Clients");
const acme = label("acme", "Acme", "clients");

beforeEach(() => {
  api.listMailLabels.mockResolvedValue([clients, acme]);
  api.createMailLabel.mockImplementation((input: { name: string }) =>
    Promise.resolve(label("new", input.name)),
  );
  api.updateMailLabel.mockResolvedValue(acme);
  api.deleteMailLabel.mockResolvedValue(["clients", "acme"]);
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

/** The label dialog once its form (not the loading state) is showing. */
function labelForm(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const dialog = dialogNamed(title);
    return dialog?.querySelector('input[name="labelName"]') ? dialog : null;
  }, `${title} form`);
}

function renderLabels() {
  return renderSettings(
    <>
      <ManageLabelsPage />
      <MailDialogsHost />
    </>,
  );
}

describe("Manage labels", () => {
  it("lists labels as a tree with counts and per-label actions", async () => {
    renderLabels();
    const list = await waitFor(() => document.querySelector('ul[aria-label="Labels"]'), "labels");
    const rows = Array.from(list.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows[0]).toContain("Clients3 conversations");
    expect(rows[1]).toContain("Acme0 conversations");
    expect(buttonNamed("Edit Clients/Acme")).not.toBeNull();
    expect(buttonNamed("Remove Clients")).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("creates a nested label with a palette color", async () => {
    renderLabels();
    click(await waitFor(() => buttonNamed("Add label"), "create button"));
    const dialog = await labelForm("New label");
    expect(await axeViolations()).toEqual([]);

    typeInto(control("Label name", dialog), "  Invoices ");
    click(control("Nest label under", dialog));
    choose(control<HTMLSelectElement>("Parent label", dialog), "acme");
    click(control("Teal", dialog));
    click(buttonNamed("Create", dialog));
    await waitFor(() => (dialogNamed("New label") === null ? true : null), "dialog to close");

    expect(api.createMailLabel).toHaveBeenCalledWith({
      name: "Invoices",
      color: "teal",
      parentId: "acme",
    });
  });

  it("explains a missing name instead of saving", async () => {
    renderLabels();
    openLabelDialog({ mode: "create" });
    const dialog = await labelForm("New label");
    click(buttonNamed("Create", dialog));
    await settle();

    const name = control("Label name", dialog);
    expect(name?.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(name?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Enter a label name.",
    );
    expect(api.createMailLabel).not.toHaveBeenCalled();
  });

  it("opens with a parent preselected", async () => {
    renderLabels();
    const request: MailLabelDialogRequest = { mode: "create", parentId: "clients" };
    openLabelDialog(request);
    const dialog = await labelForm("New label");
    expect(control("Nest label under", dialog)?.checked).toBe(true);
    expect(control<HTMLSelectElement>("Parent label", dialog)?.value).toBe("clients");
  });

  it("edits only what changed: color, and moving to the top level", async () => {
    renderLabels();
    openLabelDialog({ mode: "edit", labelId: "acme" });
    const dialog = await labelForm("Edit label");
    expect(control("Label name", dialog)?.value).toBe("Acme");
    const parent = control<HTMLSelectElement>("Parent label", dialog);
    // A label can't be nested under itself or its sublabels.
    expect(Array.from(parent?.options ?? []).map((option) => option.value)).toEqual(["clients"]);

    click(control("Nest label under", dialog));
    click(control("Red", dialog));
    click(buttonNamed("Save", dialog));
    await waitFor(() => (dialogNamed("Edit label") === null ? true : null), "dialog to close");

    expect(api.updateMailLabel).toHaveBeenCalledWith({ id: "acme", color: "red", parentId: null });
  });

  it("shows the server's reason when a save fails", async () => {
    api.createMailLabel.mockRejectedValue(
      new Error('A label named "Clients" already exists here; choose another name.'),
    );
    renderLabels();
    openLabelDialog({ mode: "create" });
    const dialog = await labelForm("New label");
    typeInto(control("Label name", dialog), "Clients");
    click(buttonNamed("Create", dialog));
    const alert = await waitFor(() => dialog.querySelector('[role="alert"]'), "error");
    expect(alert.textContent).toContain("already exists here; choose another name.");
    expect(dialogNamed("New label")).not.toBeNull();
  });

  it("removes a label and says its nested labels go too", async () => {
    renderLabels();
    click(await waitFor(() => buttonNamed("Remove Clients"), "remove button"));
    const dialog = await waitFor(
      () => dialogNamed("Remove the label “Clients”?"),
      "remove confirmation",
    );
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("Its 1 nested label is removed too.");
    click(buttonNamed("Remove", dialog));
    await waitFor(
      () => (dialogNamed("Remove the label “Clients”?") === null ? true : null),
      "close",
    );
    expect(api.deleteMailLabel).toHaveBeenCalledWith("clients");
  });

  it("closes on Escape without closing what is underneath", async () => {
    const underneath = vi.fn();
    document.addEventListener("keydown", underneath);
    renderLabels();
    openLabelDialog({ mode: "create" });
    const dialog = await labelForm("New label");
    press("Escape", {}, control("Label name", dialog));
    await settle();
    document.removeEventListener("keydown", underneath);

    expect(dialogNamed("New label")).toBeNull();
    expect(underneath).not.toHaveBeenCalled();
  });
});

describe("LabelColorMenu", () => {
  it("recolors a label from its menu", async () => {
    renderSettings(
      <Menu>
        <MenuTrigger>Clients options</MenuTrigger>
        <MenuContent aria-label="Clients options">
          <LabelColorMenu label={clients} />
        </MenuContent>
      </Menu>,
    );
    const trigger = buttonNamed("Clients options");
    trigger?.focus();
    press("Enter", {}, trigger);
    await settle();
    await key("ArrowRight");
    await settle();

    const red = await waitFor(
      () => document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Red"]'),
      "red swatch",
    );
    expect(
      document
        .querySelector('[role="menuitemradio"][aria-label="Gray"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    click(red);
    await settle();
    expect(api.updateMailLabel).toHaveBeenCalledWith({ id: "clients", color: "red" });
  });

  it("renders nothing for shared labels", () => {
    const { container } = renderSettings(
      <Menu open>
        <MenuContent aria-label="Options">
          <LabelColorMenu label={{ ...clients, shared: true }} />
        </MenuContent>
      </Menu>,
    );
    expect(container.textContent).toBe("");
    expect(document.body.textContent).not.toContain("Label color");
  });
});
