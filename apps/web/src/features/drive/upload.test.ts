import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadDriveFile, type StoragePut, type StoragePutRequest } from "./upload";

const localValues = new Map<string, string>();
const DRIVE_OBJECT_ID = "33333333-3333-4333-8333-333333333333";

function preparedBrowserUpload(
  file: File,
  input: {
    readonly storageKey: string;
    readonly uploadUrl?: string | null;
    readonly multipart?: {
      readonly uploadId: string;
      readonly partSize: number;
      readonly partCount: number;
      readonly partUrls: readonly string[];
      readonly expiresAt: string;
    };
  },
) {
  return {
    objectId: DRIVE_OBJECT_ID,
    orgId: "11111111-1111-4111-8111-111111111111",
    ownerActorId: "22222222-2222-4222-8222-222222222222",
    name: file.name,
    folderId: null,
    storageKey: input.storageKey,
    mimeType: file.type,
    byteSize: file.size,
    sha256: null,
    status: "prepared",
    uploadUrl: input.uploadUrl ?? null,
    uploadHeaders: {},
    metadata: {},
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...(input.multipart === undefined ? {} : { multipart: input.multipart }),
  };
}

function multipartPlan(urls: readonly string[], partSize: number, uploadId = "upload-1") {
  return {
    uploadId,
    partSize,
    partCount: urls.length,
    partUrls: urls,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** Records storage PUTs; each one reports half its body, then all of it. */
function fakeStorage(
  respond: (request: StoragePutRequest, attempt: number) => { status?: number; etag?: string },
) {
  const requests: StoragePutRequest[] = [];
  const attempts = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  const put = vi.fn<StoragePut>(async (request) => {
    requests.push(request);
    const attempt = (attempts.get(request.url) ?? 0) + 1;
    attempts.set(request.url, attempt);
    active += 1;
    maxActive = Math.max(maxActive, active);
    request.onProgress(Math.floor(request.body.size / 2));
    await Promise.resolve();
    request.onProgress(request.body.size);
    active -= 1;
    const result = respond(request, attempt);
    return { status: result.status ?? 200, etag: result.etag ?? null };
  });
  return { put, requests, attempts, maxActive: () => maxActive };
}

function progressEvent(loaded: number): Event {
  return Object.assign(new Event("progress"), { loaded });
}

beforeEach(() => {
  localValues.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadDriveFile", () => {
  it("streams a single upload to storage, reports byte progress, and finalizes", async () => {
    const file = new File(["0123456789"], "Roadmap_photo.png", { type: "image/png" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/Roadmap_photo.png",
            uploadUrl: "https://storage.example/upload",
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({ id: "44444444-4444-4444-8444-444444444444" }));
    const storage = fakeStorage(() => ({}));
    const progress: [number, number][] = [];
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    await expect(
      uploadDriveFile(
        { file, folderId: null, onProgress: (loaded, total) => progress.push([loaded, total]) },
        fetchImpl,
        storage.put,
      ),
    ).resolves.toMatchObject({ objectId: DRIVE_OBJECT_ID });

    expect(storage.requests).toHaveLength(1);
    expect(storage.requests[0]).toMatchObject({
      url: "https://storage.example/upload",
      headers: { "content-type": "image/png" },
      body: file,
    });
    expect(progress).toEqual([
      [0, 10],
      [5, 10],
      [10, 10],
    ]);
    const finalizeBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(finalizeBody).toEqual({
      objectId: DRIVE_OBJECT_ID,
      byteSize: 10,
      mimeType: "image/png",
      idempotencyKey: `upload:${DRIVE_OBJECT_ID}`,
      metadata: { source: "web-shell" },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("uploads Blob slices with bounded concurrency, retry, part ETags, and summed progress", async () => {
    const file = new File(["abcdefghijklmn"], "archive.bin", {
      type: "application/octet-stream",
      lastModified: 1,
    });
    const urls = ["1", "2", "3", "4"].map((part) => `https://storage.example/${part}`);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/archive.bin",
            multipart: multipartPlan(urls, 4),
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const storage = fakeStorage((request, attempt) =>
      request.url === urls[1] && attempt === 1
        ? { status: 503 }
        : { etag: `"etag-${String(urls.indexOf(request.url) + 1)}"` },
    );
    const progress: number[] = [];

    await uploadDriveFile(
      {
        file,
        folderId: null,
        onProgress: (loaded, total) => {
          expect(total).toBe(14);
          progress.push(loaded);
        },
      },
      fetchImpl,
      storage.put,
    );

    expect(storage.maxActive()).toBeLessThanOrEqual(3);
    expect(storage.attempts.get(urls[1] ?? "")).toBe(2);
    expect(storage.requests.map((request) => request.body.size).sort()).toEqual([2, 4, 4, 4, 4]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(14);
    expect(Math.max(...progress)).toBe(14);
    const completion = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as {
      parts: readonly { partNumber: number; etag: string }[];
    };
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/tools/drive.upload.complete");
    expect(completion.parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
      { partNumber: 4, etag: '"etag-4"' },
    ]);
    expect(completion).not.toHaveProperty("sha256");
    expect(localValues.size).toBe(0);
  });

  it("persists multipart parts, resumes without preparing again, and counts resumed bytes", async () => {
    const file = new File(["abcdefgh"], "resume.bin", {
      type: "application/octet-stream",
      lastModified: 2,
    });
    const urls = ["https://storage.example/resume-1", "https://storage.example/resume-2"];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/resume.bin",
            multipart: multipartPlan(urls, 4, "upload-resume"),
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const storage = fakeStorage((request, attempt) =>
      request.url === urls[1] && attempt === 1
        ? {}
        : { etag: request.url === urls[0] ? '"etag-1"' : '"etag-2"' },
    );

    await expect(uploadDriveFile({ file, folderId: null }, fetchImpl, storage.put)).rejects.toThrow(
      "did not return an ETag",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const saved = JSON.parse([...localValues.values()][0] ?? "{}") as {
      completed?: readonly { partNumber: number; etag: string }[];
    };
    expect(saved.completed).toEqual([{ partNumber: 1, etag: '"etag-1"' }]);

    const progress: number[] = [];
    await expect(
      uploadDriveFile(
        { file, folderId: null, onProgress: (loaded) => progress.push(loaded) },
        fetchImpl,
        storage.put,
      ),
    ).resolves.toMatchObject({ objectId: DRIVE_OBJECT_ID });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(storage.attempts.get(urls[0] ?? "")).toBe(1);
    expect(storage.attempts.get(urls[1] ?? "")).toBe(2);
    expect(progress).toEqual([4, 6, 8]);
    expect(localValues.size).toBe(0);
  });

  it("propagates cancellation and refuses an upload without a storage URL", async () => {
    const file = new File(["x"], "cancel.bin", { type: "application/octet-stream" });
    const controller = new AbortController();
    const cancelledFetch = vi.fn().mockResolvedValueOnce(
      Response.json(
        preparedBrowserUpload(file, {
          storageKey: "drive/111/cancel.bin",
          uploadUrl: "https://storage.example/cancel",
        }),
      ),
    );
    const put = vi.fn<StoragePut>((request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      request.signal?.throwIfAborted();
      return Promise.resolve({ status: 200, etag: null });
    });

    await expect(
      uploadDriveFile({ file, folderId: null, signal: controller.signal }, cancelledFetch, put),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledFetch).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(preparedBrowserUpload(file, { storageKey: "drive/111/cancel.bin" })),
      );
    await expect(uploadDriveFile({ file, folderId: null }, fetchImpl, put)).rejects.toThrow(
      "did not provide an upload URL",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops after a non-retryable storage error", async () => {
    const file = new File(["abc"], "denied.bin", { type: "application/octet-stream" });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        preparedBrowserUpload(file, {
          storageKey: "drive/111/denied.bin",
          uploadUrl: "https://storage.example/denied",
        }),
      ),
    );
    const storage = fakeStorage(() => ({ status: 403 }));

    await expect(uploadDriveFile({ file, folderId: null }, fetchImpl, storage.put)).rejects.toThrow(
      "Direct upload to storage failed: HTTP 403",
    );
    expect(storage.requests).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends storage PUTs with XMLHttpRequest and reports its upload progress events", async () => {
    const sent: { method: string; url: string; headers: Record<string, string>; body: Blob }[] = [];
    let pending: { xhr: EventTarget & { status: number }; body: Blob } | null = null;
    class StorageXhr extends EventTarget {
      readonly upload = new EventTarget();
      status = 0;
      aborted = false;
      #request = { method: "", url: "", headers: {} as Record<string, string> };
      open(method: string, url: string) {
        this.#request = { method, url, headers: {} };
      }
      setRequestHeader(name: string, value: string) {
        this.#request.headers[name] = value;
      }
      getResponseHeader(name: string) {
        return name === "etag" ? '"etag-xhr"' : null;
      }
      abort() {
        this.aborted = true;
        this.dispatchEvent(new Event("abort"));
      }
      send(body: Blob) {
        sent.push({ ...this.#request, body });
        pending = { xhr: this, body };
      }
    }
    vi.stubGlobal("XMLHttpRequest", StorageXhr);
    const file = new File(["0123456789"], "notes.txt", { type: "text/plain" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/notes.txt",
            uploadUrl: "https://storage.example/xhr",
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const progress: number[] = [];
    const upload = uploadDriveFile(
      { file, folderId: null, onProgress: (loaded) => progress.push(loaded) },
      fetchImpl,
    );
    await vi.waitFor(() => {
      expect(pending).not.toBeNull();
    });
    const { xhr, body } = pending as unknown as { xhr: StorageXhr; body: Blob };
    xhr.upload.dispatchEvent(progressEvent(3));
    xhr.upload.dispatchEvent(progressEvent(10));
    xhr.status = 200;
    xhr.dispatchEvent(new Event("load"));
    await expect(upload).resolves.toMatchObject({ objectId: DRIVE_OBJECT_ID });
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "https://storage.example/xhr",
        headers: { "content-type": "text/plain" },
        body: file,
      },
    ]);
    expect(body).toBe(file);
    expect(progress).toEqual([0, 3, 10]);

    pending = null;
    const controller = new AbortController();
    const cancelled = uploadDriveFile(
      { file, folderId: null, signal: controller.signal },
      vi.fn().mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/notes.txt",
            uploadUrl: "https://storage.example/xhr",
          }),
        ),
      ),
    );
    await vi.waitFor(() => {
      expect(pending).not.toBeNull();
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect((pending as unknown as { xhr: StorageXhr }).xhr.aborted).toBe(true);
  });
});
