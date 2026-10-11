// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeopleDirectoryPerson } from "@/features/people/api";
import { axeViolations, byRole, click, mount, press, settle, unmountAll } from "@/test/ui";
import { createChatRoom, discoverChatRooms, joinChatRoom, type ChatRoomRecord } from "./api";
import { NewChat } from "./new-chat";

vi.mock("./api", () => ({
  createChatRoom: vi.fn(),
  joinChatRoom: vi.fn(),
  discoverChatRooms: vi.fn(),
}));

const person = (id: string, displayName: string, email: string): PeopleDirectoryPerson => ({
  id,
  kind: "directory",
  actorId: id,
  email,
  displayName,
  title: null,
  favorite: false,
  avatarDataUrl: null,
  relationship: {},
});
const sam = person("00000000-0000-4000-8000-000000000111", "Sam Patel", "sam@helix.test");
const ada = person("00000000-0000-4000-8000-000000000112", "Ada Lund", "ada@helix.test");

vi.mock("@/features/people/api", () => ({
  usePeopleSearch: (query: string) => ({
    people: [sam, ada].filter((entry) =>
      entry.displayName.toLowerCase().startsWith(query.trim().toLowerCase()),
    ),
    loading: false,
    error: false,
  }),
}));

const space = (
  id: string,
  name: string,
  privacy: "discoverable" | "restricted",
): ChatRoomRecord => ({
  id,
  orgId: "org",
  kind: "chat_room",
  subject: name,
  createdByActorId: null,
  metadata: {},
  members: [],
  settings: {
    threadId: id,
    orgId: "org",
    name,
    topic: `${name} topic`,
    privacy,
    readReceiptsEnabled: true,
    spaceType: "conversation",
    historyPolicy: "full",
    retentionDays: null,
    legalHold: false,
    notificationPolicy: "all",
    externalAccess: "guests",
    metadata: {},
    createdAt: "2026-05-20T11:00:00.000Z",
    updatedAt: "2026-05-20T11:00:00.000Z",
  },
  createdAt: "2026-05-20T11:00:00.000Z",
  updatedAt: "2026-05-20T11:00:00.000Z",
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

function render(onOpenRoom = vi.fn(), joined: ReadonlySet<string> = new Set()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mount(
    <QueryClientProvider client={client}>
      <NewChat variant="sidebar" joinedRoomIds={joined} onOpenRoom={onOpenRoom} />
    </QueryClientProvider>,
  );
  return onOpenRoom;
}

async function choose(item: string) {
  const trigger = document.querySelector<HTMLButtonElement>("button.chat-new-chat");
  expect(trigger?.textContent).toBe("New chat");
  trigger?.focus();
  press("Enter", {}, trigger);
  await settle();
  expect(byRole("menuitem").map((entry) => entry.textContent)).toEqual([
    "Start a chat",
    "Create a space",
    "Browse spaces",
  ]);
  click(byRole("menuitem", item)[0] ?? null);
  await settle();
}

function pick(name: string) {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (input === null) throw new Error("Expected the people picker.");
  act(() => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  press("Enter", {}, input);
}

function submit(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  click(button ?? null);
}

describe("NewChat", () => {
  it("starts a direct message with one person picked from the directory", async () => {
    vi.mocked(createChatRoom).mockResolvedValue({ ...space("dm-1", "", "restricted") });
    const onOpenRoom = render();
    await choose("Start a chat");

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Start a chat");
    expect(document.body.textContent).not.toMatch(/actor|uuid/iu);
    pick("sam");
    expect(document.body.textContent).toContain("Add one person for a direct message");
    expect(await axeViolations(document.body)).toEqual([]);
    submit("Start chat");
    await settle();

    expect(createChatRoom).toHaveBeenCalledWith({ kind: "chat_dm", memberActorIds: [sam.actorId] });
    expect(onOpenRoom).toHaveBeenCalledWith("dm-1");
  });

  it("starts a group conversation with several people", async () => {
    vi.mocked(createChatRoom).mockResolvedValue(space("group-1", "", "restricted"));
    render();
    await choose("Start a chat");
    pick("sam");
    pick("ada");
    expect(document.body.textContent).toContain("Starts a group conversation");
    submit("Start chat");
    await settle();
    expect(createChatRoom).toHaveBeenCalledWith({
      kind: "chat_dm",
      memberActorIds: [sam.actorId, ada.actorId],
    });
  });

  it("creates a space with name, description and access, without admin policies", async () => {
    vi.mocked(createChatRoom).mockResolvedValue(space("space-1", "Launch", "discoverable"));
    const onOpenRoom = render();
    await choose("Create a space");

    for (const hidden of ["Legal hold", "Retention", "History"]) {
      expect(document.body.textContent).not.toContain(hidden);
    }
    const name = document.querySelector<HTMLInputElement>("input.input[required]");
    const description = document.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setInput?.call(name, "Launch");
      name?.dispatchEvent(new Event("input", { bubbles: true }));
      const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setArea?.call(description, "Ship it");
      description?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1] ?? null);
    expect(await axeViolations(document.body)).toEqual([]);
    submit("Create");
    await settle();

    expect(createChatRoom).toHaveBeenCalledWith({
      kind: "chat_room",
      subject: "Launch",
      topic: "Ship it",
      privacy: "discoverable",
      memberActorIds: [],
    });
    expect(onOpenRoom).toHaveBeenCalledWith("space-1");
  });

  it("browses discoverable spaces to join or open", async () => {
    vi.mocked(discoverChatRooms).mockResolvedValue([
      space("joined", "Design crit", "discoverable"),
      space("open", "Coffee chat", "discoverable"),
    ]);
    vi.mocked(joinChatRoom).mockResolvedValue(space("open", "Coffee chat", "discoverable"));
    const onOpenRoom = render(vi.fn(), new Set(["joined"]));
    await choose("Browse spaces");
    await settle();

    const list = document.querySelector('ul[aria-label="Spaces"]');
    expect(list?.textContent).toContain("Design crit");
    click(document.querySelector('button[aria-label="Open Design crit"]'));
    expect(onOpenRoom).toHaveBeenCalledWith("joined");
  });

  it("joins a space from Browse spaces", async () => {
    vi.mocked(discoverChatRooms).mockResolvedValue([space("open", "Coffee chat", "discoverable")]);
    vi.mocked(joinChatRoom).mockResolvedValue(space("open", "Coffee chat", "discoverable"));
    const onOpenRoom = render();
    await choose("Browse spaces");
    await settle();
    click(document.querySelector('button[aria-label="Join Coffee chat"]'));
    await settle();
    expect(joinChatRoom).toHaveBeenCalledWith("open");
    expect(onOpenRoom).toHaveBeenCalledWith("open");
  });
});
