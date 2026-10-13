import { describe, expect, it } from "vitest";
import { driveItemFromEntry } from "./drive-data";
import { driveItemActions } from "./drive-item-actions";
import { entry } from "./drive-test-server";

const file = driveItemFromEntry(entry({ id: "a", type: "file", name: "a.pdf" }));
const starred = driveItemFromEntry(
  entry({ id: "b", type: "file", name: "b.pdf", metadata: { starred: true } }),
);
const folder = driveItemFromEntry(entry({ id: "f", type: "folder", name: "Plans" }));
const scanning = driveItemFromEntry(
  entry({ id: "s", type: "file", name: "s.zip", uploadState: "scanning", available: false }),
);

const labels = (actions: ReturnType<typeof driveItemActions>) =>
  actions.map((action) => action.label);

describe("driveItemActions", () => {
  it("offers the Drive menu for a single file", () => {
    expect(labels(driveItemActions([file], { trash: false }))).toEqual([
      "Download",
      "Share",
      "Copy link",
      "Rename",
      "Make a copy",
      "Move",
      "Add to starred",
      "File information",
      "Requests and approvals",
      "Move to trash",
    ]);
  });

  it("opens folders and never stars them", () => {
    const actions = labels(driveItemActions([folder], { trash: false }));
    expect(actions[0]).toBe("Open");
    expect(actions).toContain("Folder information");
    expect(actions).not.toContain("Add to starred");
    expect(actions).not.toContain("Download");
  });

  it("copies files, never folders, and lets go of other people's items instead of trashing them", () => {
    expect(labels(driveItemActions([folder], { trash: false }))).not.toContain("Make a copy");
    const shared = labels(driveItemActions([file], { trash: false, shared: true }));
    expect(shared).toContain("Make a copy");
    expect(shared).toContain("Remove from Shared with me");
    expect(shared).not.toContain("Move to trash");
  });

  it("applies to the whole selection", () => {
    const actions = driveItemActions([file, starred], { trash: false });
    expect(labels(actions)).toEqual([
      "Download",
      "Make a copy",
      "Move",
      "Add to starred",
      "Move to trash",
    ]);
    expect(labels(driveItemActions([starred], { trash: false }))).toContain("Remove from starred");
    expect(labels(driveItemActions([file, folder], { trash: false }))).toEqual([
      "Move",
      "Move to trash",
    ]);
  });

  it("disables download and share until the security scan is clean", () => {
    const actions = driveItemActions([scanning], { trash: false });
    expect(actions.find((action) => action.id === "download")?.disabled).toBe(true);
    expect(actions.find((action) => action.id === "share")?.disabled).toBe(true);
  });

  it("offers restore and delete forever in Trash, gated by the recovery window", () => {
    const trashed = driveItemFromEntry(
      entry({
        id: "t",
        type: "file",
        name: "old.pdf",
        deletedAt: "2026-01-01T00:00:00Z",
        trashPurgeAfter: "2026-01-31T00:00:00Z",
      }),
    );
    const early = driveItemActions([trashed], { trash: true, now: Date.parse("2026-01-10") });
    expect(labels(early)).toEqual(["Restore", "Delete forever", "File information"]);
    expect(early.find((action) => action.id === "delete-forever")?.disabled).toBe(true);
    const late = driveItemActions([trashed], { trash: true, now: Date.parse("2026-02-01") });
    expect(late.find((action) => action.id === "delete-forever")?.disabled).toBe(false);
  });
});
