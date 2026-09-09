import type { DriveFileStreamResult, DriveStore } from "./drive/store.js";

export interface ImportSource {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export type ImportSourceReader = Pick<DriveStore, "openFile">;

/** Read an authorized Drive object only after its declared and streamed sizes pass the limit. */
export async function readImportSource(
  reader: ImportSourceReader | undefined,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly maxBytes: number;
  },
): Promise<ImportSource> {
  if (reader?.openFile === undefined) {
    throw new Error("Drive object imports are unavailable.");
  }
  const source = await reader.openFile({
    orgId: input.orgId,
    actorId: input.actorId,
    objectId: input.objectId,
  });
  if (source === null) {
    throw new Error(`Unknown or inaccessible Drive object: ${input.objectId}`);
  }
  if (source.byteSize > input.maxBytes) {
    throw importTooLarge(input.maxBytes);
  }
  const body = await source.open();
  if (body === null) {
    throw new Error(`Drive object content is unavailable: ${input.objectId}`);
  }
  return {
    name: source.entry.name,
    mimeType: source.entry.mimeType ?? "application/octet-stream",
    bytes: await collectBytes(body, input.maxBytes),
  };
}

async function collectBytes(
  body: Awaited<ReturnType<DriveFileStreamResult["open"]>> & {},
  maxBytes: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw importTooLarge(maxBytes);
    return body;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw importTooLarge(maxBytes);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function importTooLarge(maxBytes: number): Error {
  return new Error(`Import source exceeds the ${String(maxBytes)} byte limit.`);
}
