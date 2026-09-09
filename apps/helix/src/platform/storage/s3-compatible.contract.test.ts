import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createS3CompatibleStorage } from "./index.js";

const endpoint = process.env.S3_CONTRACT_ENDPOINT;
const accessKeyId = process.env.S3_CONTRACT_ACCESS_KEY;
const secretAccessKey = process.env.S3_CONTRACT_SECRET_KEY;
const bucket = process.env.S3_CONTRACT_BUCKET ?? "helix-objects";

describe.runIf(
  endpoint !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined,
)("S3-compatible storage contract", () => {
  it("round-trips signed, ranged, copied, presigned, and multipart objects", async () => {
    if (endpoint === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
      throw new Error("S3 contract credentials are required");
    }
    const client = createS3CompatibleStorage({
      endpoint,
      region: "us-east-1",
      bucket,
      credentials: { accessKeyId, secretAccessKey },
      fetch,
      requestTimeoutMs: 5_000,
    });
    const prefix = `min-05-contract/${randomUUID()}`;
    const keys = {
      source: `${prefix}/source.txt`,
      copy: `${prefix}/copy.txt`,
      presigned: `${prefix}/presigned.txt`,
      multipart: `${prefix}/multipart.txt`,
    };
    let uploadId: string | undefined;
    const payload = new TextEncoder().encode("rustfs-contract-payload");

    try {
      await client.checkHealth();
      await client.put({
        key: keys.source,
        body: payload,
        contentType: "text/plain",
        metadata: { contract: "min-05" },
      });
      await expect(client.head(keys.source)).resolves.toMatchObject({
        byteSize: payload.byteLength,
        contentType: "text/plain",
        metadata: { contract: "min-05" },
      });
      await expect(client.get(keys.source)).resolves.toMatchObject({ body: payload });
      await expect(readBody(await client.getRange(keys.source, 7, 14))).resolves.toBe("contract");

      await client.copy(keys.source, keys.copy);
      await expect(readBody(await client.getStream(keys.copy))).resolves.toBe(
        "rustfs-contract-payload",
      );

      const presigned = await client.presignPutRequest(keys.presigned, {
        contentType: "text/plain",
        metadata: { contract: "presigned" },
      });
      const upload = await fetch(presigned.url, {
        method: "PUT",
        headers: presigned.headers,
        body: payload,
      });
      expect(upload.ok).toBe(true);
      await expect(readBody(await client.get(keys.presigned))).resolves.toBe(
        "rustfs-contract-payload",
      );

      uploadId = (await client.createMultipartUpload(keys.multipart)).uploadId;
      const partUpload = await fetch(await client.presignUploadPart(keys.multipart, uploadId, 1), {
        method: "PUT",
        body: payload,
      });
      expect(partUpload.ok).toBe(true);
      const etag = partUpload.headers.get("etag");
      if (etag === null) throw new Error("S3 multipart upload omitted ETag");
      await client.completeMultipartUpload(keys.multipart, uploadId, [{ partNumber: 1, etag }]);
      uploadId = undefined;
      await expect(readBody(await client.get(keys.multipart))).resolves.toBe(
        "rustfs-contract-payload",
      );
    } finally {
      if (uploadId !== undefined) {
        await client.abortMultipartUpload(keys.multipart, uploadId).catch(() => undefined);
      }
      await Promise.all(
        Object.values(keys).map((key) => client.delete(key).catch(() => undefined)),
      );
    }
  });
});

async function readBody(
  object: Awaited<ReturnType<ReturnType<typeof createS3CompatibleStorage>["get"]>>,
) {
  if (object === null) return null;
  if (object.body instanceof Uint8Array) return new TextDecoder().decode(object.body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of object.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
