// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeopleDirectoryPerson } from "@/features/people/api";
import { axeViolations, click, unmountAll } from "@/test/ui";
import type { DriveShareLink } from "./api";
import { generalAccessFromLinks } from "./drive-general-access";
import { DriveShareDialog, type DriveShareTarget } from "./drive-share-dialog";
import { fakeDriveApi, flush, ME, mountWithQueries, OTHER } from "./drive-test-server";

const { search } = vi.hoisted(() => ({
  search: vi.fn<(query: string) => readonly PeopleDirectoryPerson[]>(),
}));
vi.mock("@/features/people/api", () => ({
  usePeopleSearch: (query: string) => ({
    people: query.trim() === "" ? [] : search(query),
    loading: false,
    error: false,
  }),
}));

const SAM = "00000000-0000-4000-8000-000000000111";
const FILE_ID = "00000000-0000-4000-8000-000000000500";
const target: DriveShareTarget = {
  id: FILE_ID,
  kind: "file",
  name: "Plan.pdf",
  ownerActorId: ME,
  ownerName: "Owner One",
};

function link(overrides: Partial<DriveShareLink> = {}): DriveShareLink {
  return {
    id: "00000000-0000-4000-8000-000000000900",
    orgId: ME,
    objectId: FILE_ID,
    token: null,
    role: "reader",
    expiresAt: null,
    passwordProtected: false,
    oneTime: false,
    allowedDomains: [],
    allowDownload: true,
    consumedAt: null,
    createdByActorId: ME,
    createdAt: "2026-05-01T00:00:00Z",
    revokedAt: null,
    maxDownloads: null,
    downloadCount: 0,
    rateLimitPerHour: 120,
    lastUsedAt: null,
    ...overrides,
  };
}

function typeInto(input: HTMLInputElement, text: string) {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function select(label: string): HTMLSelectElement {
  const element =
    document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ??
    Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent === label,
    )?.control;
  if (!(element instanceof HTMLSelectElement)) throw new Error(`No select ${label}`);
  return element;
}

function choose(element: HTMLSelectElement, value: string) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  );
}

let links: DriveShareLink[];
let api: ReturnType<typeof fakeDriveApi>;

beforeEach(() => {
  links = [];
  search.mockReturnValue([
    {
      id: SAM,
      kind: "directory",
      actorId: SAM,
      email: "sam@helix.test",
      displayName: "Sam Patel",
      title: null,
      favorite: false,
      avatarDataUrl: null,
      relationship: {},
    },
  ]);
  api = fakeDriveApi({
    "drive.access.list": () => ({
      grants: [
        {
          actorId: OTHER,
          role: "reader",
          displayName: "Maya Chen",
          email: "maya@helix.test",
          grantedByActorId: ME,
          expiresAt: null,
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        },
      ],
    }),
    "drive.link.list": () => ({ links }),
    "drive.share": () => ({ objectId: FILE_ID, sharedWithActorIds: [SAM], role: "editor" }),
    "drive.access.update": () => ({ objectId: FILE_ID, actorId: OTHER, grant: null }),
    "drive.access.remove": () => ({ objectId: FILE_ID, actorId: OTHER, removed: true }),
    "drive.link.create": (body) => {
      const created = link({
        token: "t".repeat(43),
        allowedDomains: (body.allowedDomains as string[] | undefined) ?? [],
      });
      links = [created];
      return created;
    },
    "drive.link.revoke": (body) => {
      links = links.map((entry) =>
        entry.id === body.linkId ? { ...entry, revokedAt: "2026-05-02T00:00:00Z" } : entry,
      );
      return { id: body.linkId, revoked: true };
    },
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("generalAccessFromLinks", () => {
  it("maps active links to Restricted, organization or anyone access", () => {
    expect(generalAccessFromLinks([])).toBe("restricted");
    expect(generalAccessFromLinks([link({ revokedAt: "2026-01-01T00:00:00Z" })])).toBe(
      "restricted",
    );
    expect(generalAccessFromLinks([link({ allowedDomains: ["helix.test"] })])).toBe("domain");
    expect(generalAccessFromLinks([link()])).toBe("anyone");
  });
});

describe("DriveShareDialog", () => {
  it("adds people from the picker with the chosen role", async () => {
    mountWithQueries(<DriveShareDialog target={target} onClose={vi.fn()} />);
    await flush();
    expect(document.body.textContent).toContain("Owner One (you)");
    expect(document.body.textContent).toContain("Maya Chen");

    const combobox = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (combobox === null) throw new Error("people picker missing");
    typeInto(combobox, "sa");
    click(document.querySelector('[role="option"]'));
    choose(select("Role for new people"), "editor");
    click(buttonNamed("Share") ?? null);
    await flush();

    expect(api.called("drive.share")[0]?.body).toMatchObject({
      objectId: FILE_ID,
      actorIds: [SAM],
      role: "editor",
    });
    expect(await axeViolations()).toEqual([]);
  });

  it("changes and removes access for people already shared", async () => {
    mountWithQueries(<DriveShareDialog target={target} onClose={vi.fn()} />);
    await flush();
    const role = select("Access for Maya Chen");
    expect(Array.from(role.options).map((option) => option.textContent)).toEqual([
      "Viewer",
      "Commenter",
      "Editor",
      "Remove access",
    ]);
    choose(role, "commenter");
    await flush();
    expect(api.called("drive.access.update")[0]?.body).toMatchObject({
      actorId: OTHER,
      role: "commenter",
    });
    choose(select("Access for Maya Chen"), "remove");
    await flush();
    expect(api.called("drive.access.remove")[0]?.body).toMatchObject({ actorId: OTHER });
  });

  it("switches general access between restricted, the organization and anyone", async () => {
    mountWithQueries(<DriveShareDialog target={target} onClose={vi.fn()} />);
    await flush();
    const general = select("General access");
    expect(general.value).toBe("restricted");
    expect(Array.from(general.options).map((option) => option.textContent)).toEqual([
      "Restricted",
      "Anyone at helix.test",
      "Anyone with the link",
    ]);

    choose(general, "domain");
    await flush();
    expect(api.called("drive.link.create")[0]?.body).toMatchObject({
      allowedDomains: ["helix.test"],
    });
    expect(select("General access").value).toBe("domain");

    choose(select("General access"), "anyone");
    await flush();
    expect(api.called("drive.link.revoke")).toHaveLength(1);
    expect(api.called("drive.link.create")[1]?.body).toMatchObject({ allowedDomains: [] });

    choose(select("General access"), "restricted");
    await flush();
    expect(api.called("drive.link.revoke")).toHaveLength(2);
    expect(select("General access").value).toBe("restricted");
  });

  it("copies the in-app link and closes with Done", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onClose = vi.fn();
    mountWithQueries(<DriveShareDialog target={target} onClose={onClose} />);
    await flush();
    click(buttonNamed("Copy link") ?? null);
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/drive?file=${FILE_ID}`);
    click(buttonNamed("Done") ?? null);
    expect(onClose).toHaveBeenCalled();
  });
});
