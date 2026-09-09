import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { buildHelixRequest, type HelixCliEnv } from "./client.js";
import type { CliIo, FetchLike } from "./runner.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** File-backed blobs bound memory and detect file changes between hashing and PUT. */
export async function uploadLocalDriveFile(
  path: string,
  input: unknown,
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  if (!record(input)) throw new Error("Drive upload options must be an object.");
  const { preparedFile, ...options } = input;
  const mimeType =
    typeof options.mimeType === "string" ? options.mimeType : "application/octet-stream";
  const file = await openAsBlob(path, { type: mimeType });
  const hash = createHash("sha256");
  for await (const chunk of file.stream()) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Invalid file stream chunk.");
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (options.byteSize !== undefined && options.byteSize !== file.size)
    throw new Error("Declared byte size does not match the local file.");
  if (
    options.sha256 !== undefined &&
    (typeof options.sha256 !== "string" || options.sha256.toLowerCase() !== sha256)
  )
    throw new Error("Declared SHA-256 does not match the local file.");

  const invoke = async (toolId: string, body: unknown): Promise<unknown> => {
    const request = buildHelixRequest(
      { kind: "tool-call", toolId, json: { source: "empty" } },
      env,
      body,
    );
    const response = await fetchImpl(request.url, request.init);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${text}`);
    return JSON.parse(text) as unknown;
  };
  const supplied: unknown =
    typeof preparedFile === "string"
      ? JSON.parse(await readFile(preparedFile, "utf8"))
      : await invoke("drive.upload", { ...options, mimeType, byteSize: file.size, sha256 });
  const prepared = record(supplied) && record(supplied.prepared) ? supplied.prepared : supplied;
  if (record(prepared) && prepared.status === "pending_confirmation") {
    io.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    io.stderr.write(
      "Upload awaits approval. Save the approved result and resume with --prepared <json-file>.\n",
    );
    return 2;
  }
  if (
    !record(prepared) ||
    typeof prepared.objectId !== "string" ||
    prepared.byteSize !== file.size ||
    prepared.sha256 !== sha256
  )
    throw new Error("Prepared upload does not match this file's size and SHA-256.");

  const put = async (url: unknown, body: Blob, extraHeaders: unknown = {}): Promise<Response> => {
    if (typeof url !== "string") throw new Error("Upload URL is missing.");
    const target = new URL(url);
    if (
      target.username ||
      target.password ||
      (target.protocol !== "https:" &&
        !(
          target.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
        ))
    )
      throw new Error("Upload URL must use HTTPS (or local HTTP for development).");
    const headers = new Headers({ "content-type": mimeType });
    if (!record(extraHeaders)) throw new Error("Invalid upload headers.");
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (typeof value !== "string" || /^(authorization|cookie|proxy-authorization)$/iu.test(key))
        throw new Error("Invalid storage upload header.");
      headers.set(key, value);
    }
    const response = await fetchImpl(target.href, {
      method: "PUT",
      headers,
      body,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Storage upload failed: HTTP ${String(response.status)}.`);
    return response;
  };
  try {
    let result: unknown;
    if (prepared.multipart !== undefined) {
      const plan = prepared.multipart;
      if (
        !record(plan) ||
        typeof plan.uploadId !== "string" ||
        !plan.uploadId ||
        typeof plan.partSize !== "number" ||
        !Number.isSafeInteger(plan.partSize) ||
        plan.partSize <= 0 ||
        typeof plan.partCount !== "number" ||
        !Number.isSafeInteger(plan.partCount) ||
        plan.partCount < 1 ||
        plan.partCount > 10_000 ||
        plan.partCount !== Math.ceil(file.size / plan.partSize) ||
        !Array.isArray(plan.partUrls) ||
        plan.partUrls.length !== plan.partCount
      )
        throw new Error("Invalid multipart upload plan.");
      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (let index = 0; index < plan.partCount; index += 1) {
        const response = await put(
          plan.partUrls[index],
          file.slice(index * plan.partSize, (index + 1) * plan.partSize),
        );
        const etag = response.headers.get("etag");
        if (!etag) throw new Error("Storage did not return a multipart ETag.");
        parts.push({ partNumber: index + 1, etag });
      }
      result = await invoke("drive.upload.complete", {
        objectId: prepared.objectId,
        uploadId: plan.uploadId,
        parts,
        byteSize: file.size,
        sha256,
        mimeType,
      });
    } else {
      await put(prepared.uploadUrl, file, prepared.uploadHeaders ?? {});
      result = await invoke("drive.finalize", {
        objectId: prepared.objectId,
        byteSize: file.size,
        sha256,
        mimeType,
        idempotencyKey: `upload:${prepared.objectId}`,
      });
    }
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return record(result) && result.status === "pending_confirmation" ? 2 : 0;
  } catch (error) {
    // The caller can save this response and repeat PUTs against the same reserved object.
    io.stdout.write(`${JSON.stringify({ prepared }, null, 2)}\n`);
    throw error;
  }
}
