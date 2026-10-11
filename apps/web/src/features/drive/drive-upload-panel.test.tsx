// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, unmountAll } from "@/test/ui";
import { fakeDriveApi, flush, mountWithQueries } from "./drive-test-server";
import { DriveUploadPanel, uploadPanelTitle, uploadTaskStatus } from "./drive-upload-panel";
import {
  folderPathsForUpload,
  uploadErrorMessage,
  useDriveUploads,
  type DriveUploadTask,
} from "./use-drive-uploads";

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function task(overrides: Partial<DriveUploadTask> & Pick<DriveUploadTask, "id">): DriveUploadTask {
  return {
    name: `${overrides.id}.pdf`,
    size: 1000,
    uploadedBytes: 0,
    phase: "queued",
    message: null,
    objectId: null,
    ...overrides,
  };
}

describe("upload panel copy", () => {
  it("summarises the queue the way Drive does", () => {
    expect(uploadPanelTitle([task({ id: "a", phase: "uploading" }), task({ id: "b" })])).toBe(
      "Uploading 2 items",
    );
    expect(uploadPanelTitle([task({ id: "a", phase: "scanning" })])).toBe("Scanning 1 item");
    expect(
      uploadPanelTitle([task({ id: "a", phase: "done" }), task({ id: "b", phase: "done" })]),
    ).toBe("2 uploads complete");
    expect(uploadPanelTitle([task({ id: "a", phase: "blocked" })])).toBe(
      "1 upload needs attention",
    );
  });

  it("describes each state, including the malware scan", () => {
    expect(uploadTaskStatus(task({ id: "a", phase: "uploading", uploadedBytes: 512 }))).toBe(
      "512 B of 1000 B",
    );
    expect(uploadTaskStatus(task({ id: "a", phase: "scanning" }))).toBe("Scanning…");
    expect(
      uploadTaskStatus(task({ id: "a", phase: "blocked", message: "This file is quarantined." })),
    ).toBe("This file is quarantined.");
    expect(uploadErrorMessage(new TypeError("Failed to fetch"))).toMatch(/Couldn’t reach/u);
  });

  it("lets people cancel, retry, minimize and close", async () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const onClose = vi.fn();
    mount(
      <DriveUploadPanel
        tasks={[
          task({ id: "a", phase: "uploading", uploadedBytes: 250 }),
          task({ id: "b", phase: "failed", message: "Network down" }),
        ]}
        onCancel={onCancel}
        onRetry={onRetry}
        onClose={onClose}
      />,
    );
    const progress = document.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-valuenow")).toBe("25");
    click(document.querySelector('[aria-label="Cancel upload of a.pdf"]'));
    expect(onCancel).toHaveBeenCalledWith("a");
    click(document.querySelector('[aria-label="Retry upload of b.pdf"]'));
    expect(onRetry).toHaveBeenCalledWith("b");
    expect(await axeViolations()).toEqual([]);
    click(document.querySelector('[aria-label="Minimize uploads"]'));
    expect(document.querySelector('[aria-label="Upload progress"]')).toBeNull();
    click(document.querySelector('[aria-label="Cancel uploads and close"]'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("folderPathsForUpload", () => {
  it("creates parents before children", () => {
    expect(folderPathsForUpload(["Trip/a.jpg", "Trip/Day 2/b.jpg", "Trip/Day 1/c.jpg"])).toEqual([
      "Trip",
      "Trip/Day 1",
      "Trip/Day 2",
    ]);
  });
});

describe("useDriveUploads", () => {
  const OBJECT_ID = "33333333-3333-4333-8333-333333333333";

  function Harness({ onReady }: { onReady: (api: ReturnType<typeof useDriveUploads>) => void }) {
    const uploads = useDriveUploads();
    onReady(uploads);
    return (
      <ul>
        {uploads.tasks.map((entry) => (
          <li key={entry.id} data-phase={entry.phase}>
            {entry.name}: {entry.message}
          </li>
        ))}
      </ul>
    );
  }

  it("uploads, waits for the scan and reports a blocked file", async () => {
    let state = "scanning";
    const api = fakeDriveApi({
      "drive.upload": (body) => ({
        objectId: OBJECT_ID,
        orgId: OBJECT_ID,
        ownerActorId: OBJECT_ID,
        name: body.name,
        folderId: body.folderId,
        storageKey: "k",
        mimeType: "application/pdf",
        byteSize: 3,
        sha256: null,
        status: "pending_upload",
        uploadUrl: "https://storage.test/put",
        uploadHeaders: {},
        metadata: {},
        createdAt: "",
        updatedAt: "",
      }),
      "drive.finalize": () => ({}),
      "drive.upload.status": () => ({
        objectId: OBJECT_ID,
        state,
        label: state,
        available: state === "active",
        terminal: state !== "scanning",
        updatedAt: "",
      }),
    });
    const putFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith("https://storage.test")
          ? Promise.resolve(new Response(null, { status: 200 }))
          : putFetch(input, init);
      }),
    );
    let uploads: ReturnType<typeof useDriveUploads> | undefined;
    mountWithQueries(<Harness onReady={(value) => (uploads = value)} />);
    uploads?.uploadFiles([new File(["abc"], "plan.pdf", { type: "application/pdf" })], "folder-1");
    await flush();
    expect(api.called("drive.upload")[0]?.body).toMatchObject({
      name: "plan.pdf",
      folderId: "folder-1",
    });
    expect(document.querySelector("li")?.getAttribute("data-phase")).toBe("scanning");

    state = "quarantined";
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await flush();
    expect(document.querySelector("li")?.getAttribute("data-phase")).toBe("blocked");
    expect(document.querySelector("li")?.textContent).toContain("quarantined");
  });

  it("recreates a picked folder's structure before uploading into it", async () => {
    let folderCount = 0;
    const api = fakeDriveApi({
      "drive.create": () => {
        folderCount += 1;
        return { id: `00000000-0000-4000-8000-00000000000${String(folderCount)}` };
      },
      "drive.upload": () => {
        throw new Error("Storage is full");
      },
    });
    const file = new File(["x"], "a.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "Trip/Day 1/a.txt" });
    let uploads: ReturnType<typeof useDriveUploads> | undefined;
    mountWithQueries(<Harness onReady={(value) => (uploads = value)} />);
    await uploads?.uploadFolder([file], null);
    await flush();
    expect(api.called("drive.create").map((call) => call.body)).toEqual([
      { kind: "folder", name: "Trip", folderId: null },
      {
        kind: "folder",
        name: "Day 1",
        folderId: "00000000-0000-4000-8000-000000000001",
      },
    ]);
    expect(api.called("drive.upload")[0]?.body).toMatchObject({
      folderId: "00000000-0000-4000-8000-000000000002",
    });
    expect(document.querySelector("li")?.getAttribute("data-phase")).toBe("failed");
    expect(document.querySelector("li")?.textContent).toContain("Storage is full");
  });
});
