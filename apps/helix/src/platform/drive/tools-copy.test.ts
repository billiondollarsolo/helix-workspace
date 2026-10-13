import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { registerDriveCopyTool } from "./tools-copy.js";
import type { DriveEntryRecord } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const someoneElse = "22222222-2222-4222-8222-222222222223";
const sourceId = "33333333-3333-4333-8333-333333333333";
const copyId = "33333333-3333-4333-8333-333333333334";
const sourceFolder = "44444444-4444-4444-8444-444444444444";
const otherFolder = "44444444-4444-4444-8444-444444444445";
const bytes = Buffer.from("quarterly numbers");

type Call = readonly [method: string, input: Record<string, unknown>];

function setup(
  options: {
    readonly owner?: string;
    readonly dlp?: "allow" | "block";
    readonly exportable?: boolean;
    readonly finalizeFails?: boolean;
    readonly maxBytes?: number;
  } = {},
) {
  const calls: Call[] = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    calls.push([method, input]);
    return {};
  };
  const registry = createToolRegistry();
  registerDriveCopyTool(registry, {
    maxBytes: options.maxBytes,
    dlp: {
      evaluate: async () =>
        ({ action: options.dlp ?? "allow", classification: "internal" }) as never,
    },
    store: {
      openFile: async () => ({
        byteSize: bytes.byteLength,
        etag: '"etag"',
        open: async () => bytes,
        entry: {
          id: sourceId,
          name: "Budget.xlsx",
          folderId: sourceFolder,
          ownerActorId: options.owner ?? me,
          mimeType: "application/vnd.ms-excel",
        } as DriveEntryRecord,
      }),
      canExportFile: async () => options.exportable ?? true,
      prepareUpload: async (input) => {
        calls.push(["prepareUpload", { ...input }]);
        return { objectId: copyId } as never;
      },
      finalizeUpload: async (input) => {
        calls.push(["finalizeUpload", { ...input }]);
        if (options.finalizeFails === true) throw new Error("scanner offline");
        return {} as never;
      },
      trash: record("trash") as never,
      delete: record("delete") as never,
    },
  });
  const copy = (input: Record<string, unknown> = {}, scopes = ["drive.read", "drive.write"]) =>
    registry.invoke(
      "drive.copy",
      { objectId: sourceId, ...input },
      { actor: { id: me, orgId, type: "user", scopes } },
    );
  return { calls, copy };
}

describe("drive.copy", () => {
  it("writes the copy through the upload path, beside an original the actor owns", async () => {
    const { calls, copy } = setup();
    await expect(copy()).resolves.toMatchObject({
      ok: true,
      output: { objectId: copyId, name: "Copy of Budget.xlsx", folderId: sourceFolder },
    });
    // prepareUpload is where storage quota is charged; finalizeUpload is where the bytes are scanned.
    expect(calls.map(([method]) => method)).toEqual(["prepareUpload", "finalizeUpload"]);
    expect(calls[0]?.[1]).toMatchObject({
      orgId,
      actorId: me,
      name: "Copy of Budget.xlsx",
      folderId: sourceFolder,
      mimeType: "application/vnd.ms-excel",
      byteSize: bytes.byteLength,
    });
    expect(calls[1]?.[1]).toMatchObject({ objectId: copyId, content: bytes });
  });

  it("puts a copy of someone else's file in the actor's own Drive unless told where", async () => {
    const shared = setup({ owner: someoneElse });
    await expect(shared.copy()).resolves.toMatchObject({ output: { folderId: null } });
    const chosen = setup({ owner: someoneElse });
    await expect(chosen.copy({ folderId: otherFolder })).resolves.toMatchObject({
      output: { folderId: otherFolder },
    });
  });

  it("is refused wherever a download would be", async () => {
    for (const [options, scopes] of [
      [{ dlp: "block" }, undefined],
      [{ exportable: false }, undefined],
      [{ maxBytes: 4 }, undefined],
      // A credential that may write but not read cannot use a copy to read.
      [{}, ["drive.write"]],
    ] as const) {
      const { calls, copy } = setup(options);
      await expect(copy({}, scopes === undefined ? undefined : [...scopes])).resolves.toMatchObject(
        {
          ok: false,
        },
      );
      expect(calls).toEqual([]);
    }
  });

  it("leaves nothing behind when the copy cannot be scanned and stored", async () => {
    const { calls, copy } = setup({ finalizeFails: true });
    await expect(copy()).resolves.toMatchObject({ ok: false });
    expect(calls.map(([method]) => method)).toEqual([
      "prepareUpload",
      "finalizeUpload",
      "trash",
      "delete",
    ]);
    expect(calls[3]?.[1]).toMatchObject({ objectId: copyId });
  });
});
