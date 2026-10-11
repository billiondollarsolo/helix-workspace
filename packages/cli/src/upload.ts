import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { buildHelixRequest } from "./client.js";
import { pendingActionId, reportPending } from "./options.js";
import { sendForText } from "./http.js";
import type { CliContext } from "./runner.js";

/**
 * Lowest storage throughput the CLI waits for before giving up on a PUT. The
 * per-request timeout covers connection setup and the response; the body
 * transfer gets extra time in proportion to its size instead of a fixed cap.
 */
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Accepts the `drive.upload` result itself, a saved `{prepared}` failure
 * record, or the `{status:"executed", output}` printed by `helix action approve`.
 */
function unwrapPrepared(supplied: unknown): unknown {
  if (record(supplied) && record(supplied.prepared)) return supplied.prepared;
  if (record(supplied) && supplied.status === "executed" && record(supplied.output)) {
    return record(supplied.output.prepared) ? supplied.output.prepared : supplied.output;
  }
  return supplied;
}

/** File-backed blobs bound memory and detect file changes between hashing and PUT. */
export async function uploadLocalDriveFile(
  path: string,
  input: unknown,
  context: CliContext,
): Promise<number> {
  const { env, io, http } = context;
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

  // Each tool's idempotency record is scoped by tool id, so one key per
  // invocation covers drive.upload and its finalize/complete call.
  const invoke = async (toolId: string, body: unknown): Promise<unknown> => {
    const request = buildHelixRequest(
      { kind: "tool-call", toolId, json: { source: "empty" } },
      env,
      body,
      context.idempotencyKey,
    );
    return JSON.parse((await sendForText(request, context, true)).body) as unknown;
  };
  const supplied: unknown =
    typeof preparedFile === "string"
      ? JSON.parse(await readFile(preparedFile, "utf8"))
      : await invoke("drive.upload", { ...options, mimeType, byteSize: file.size, sha256 });
  const prepared = unwrapPrepared(supplied);
  const pendingId = pendingActionId(prepared);
  if (pendingId !== undefined) {
    io.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    return reportPending(
      io.stderr,
      context.options.output,
      pendingId,
      `save that command's output to a file and resume with: helix drive upload ${path} --prepared <file>`,
    );
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
    // CA8: a presigned PUT (or one multipart part) is safe to repeat, so it
    // is retried on network errors, 429 and 5xx, up to three times.
    const response = await http.send(
      target.href,
      { method: "PUT", headers, body },
      {
        idempotent: true,
        retryServerErrors: true,
        timeoutMs:
          http.policy.timeoutMs + Math.ceil((body.size / MIN_UPLOAD_BYTES_PER_SECOND) * 1000),
      },
    );
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
    const finalizePendingId = pendingActionId(result);
    return finalizePendingId === undefined
      ? 0
      : reportPending(io.stderr, context.options.output, finalizePendingId);
  } catch (error) {
    // The caller can save this response and repeat PUTs against the same reserved object.
    io.stdout.write(`${JSON.stringify({ prepared }, null, 2)}\n`);
    throw error;
  }
}
