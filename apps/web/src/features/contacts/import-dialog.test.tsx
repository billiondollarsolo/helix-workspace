// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyOptions } from "@/components/ui/toast";
import { axeViolations, click, settle, unmountAll } from "@/test/ui";
import { fakeContactsApi, mountWithQueries } from "./contacts-test-server";
import { ImportContactsDialog, importFormat, importLabel } from "./import-dialog";

const toasts = vi.hoisted(() => ({ list: [] as NotifyOptions[] }));
vi.mock("@/components/ui/toast", () => ({
  notify: (options: NotifyOptions) => {
    toasts.list.push(options);
    return toasts.list.length;
  },
}));

const VCF = "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada\r\nEND:VCARD\r\n";
let api: ReturnType<typeof fakeContactsApi>;

function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("No file input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === name,
  );
  if (match === undefined) throw new Error(`No button ${name}`);
  return match;
}

beforeEach(() => {
  toasts.list = [];
  api = fakeContactsApi({
    "contacts.import": (body) =>
      body.dryRun === true
        ? {
            count: 2,
            skipped: 1,
            problems: ["Card 3: it is not a valid vCard 3.0 or 4.0 card."],
            sample: ["Ada Lovelace", "Grace Hopper"],
            imported: false,
          }
        : { count: 2, skipped: 1, problems: [], sample: [], imported: true },
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("ImportContactsDialog", () => {
  it("previews the file's contacts, then imports them under a dated label", async () => {
    const onImported = vi.fn();
    const onClose = vi.fn();
    mountWithQueries(<ImportContactsDialog onClose={onClose} onImported={onImported} />);
    choose(new File([VCF], "contacts.vcf", { type: "text/vcard" }));
    await settle();
    await settle();
    expect(api.called("contacts.import")[0]?.body).toEqual({
      format: "vcard",
      content: VCF,
      dryRun: true,
    });
    expect(document.body.textContent).toContain("2 contacts are ready to import.");
    expect(document.body.textContent).toContain("Ada Lovelace, Grace Hopper");
    expect(document.body.textContent).toContain("1 entry will be skipped");
    expect(await axeViolations()).toEqual([]);

    click(button("Import 2"));
    await settle();
    await settle();
    const label = importLabel(new Date());
    expect(api.called("contacts.import")[1]?.body).toEqual({
      format: "vcard",
      content: VCF,
      dryRun: false,
      label,
    });
    expect(toasts.list.at(-1)?.message).toBe("Imported 2 contacts");
    expect(onImported).toHaveBeenCalledWith(label);
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses unsupported and oversized files before uploading", async () => {
    mountWithQueries(<ImportContactsDialog onClose={vi.fn()} onImported={vi.fn()} />);
    choose(new File(["x"], "notes.txt", { type: "text/plain" }));
    await settle();
    expect(document.body.textContent).toContain("Choose a vCard (.vcf) or CSV (.csv) file.");
    choose(new File(["x".repeat(900 * 1024 + 1)], "big.csv", { type: "text/csv" }));
    await settle();
    expect(document.body.textContent).toContain("larger than 900 KB");
    expect(api.called("contacts.import")).toEqual([]);
  });

  it("detects the format from the name or type and builds a label without commas", () => {
    expect(importFormat({ name: "a.VCF", type: "" })).toBe("vcard");
    expect(importFormat({ name: "export", type: "text/csv" })).toBe("csv");
    expect(importFormat({ name: "a.txt", type: "text/plain" })).toBeNull();
    expect(importLabel(new Date(2026, 9, 11))).not.toMatch(/[,;]/u);
  });
});
