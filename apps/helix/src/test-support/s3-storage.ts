import type { StorageClient, StorageObject } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { createS3CompatibleStorage } from "../platform/storage/index.js";

class MemoryStorage implements StorageClient {
  readonly objects = new Map<string, Uint8Array>();
  async put(object: StorageObject): Promise<void> {
    const body = object.body instanceof Uint8Array ? object.body : await collect(object.body);
    this.objects.set(object.key, body);
  }
  async get(key: string): Promise<StorageObject | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { key, body };
  }
  async getStream(key: string): Promise<StorageObject | null> {
    return this.get(key);
  }
  async getRange(key: string, start: number, end: number): Promise<StorageObject | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { key, body: body.subarray(start, end + 1) };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async copy(source: string, destination: string): Promise<void> {
    const body = this.objects.get(source);
    if (body !== undefined) this.objects.set(destination, body);
  }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Uses the live RustFS contract bucket when it is reachable, memory otherwise. */
export async function contractStorage(): Promise<{ storage: StorageClient; kind: string }> {
  const endpoint = process.env.S3_CONTRACT_ENDPOINT;
  const accessKeyId = process.env.S3_CONTRACT_ACCESS_KEY;
  const secretAccessKey = process.env.S3_CONTRACT_SECRET_KEY;
  if (endpoint !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined) {
    const client = createS3CompatibleStorage({
      endpoint,
      region: "us-east-1",
      bucket: process.env.S3_CONTRACT_BUCKET ?? "helix-objects",
      credentials: { accessKeyId, secretAccessKey },
      fetch,
      requestTimeoutMs: 3_000,
    });
    // The suite stages 6 MiB multipart parts; probe that size, not just liveness.
    const probeKey = `drive-s3-gateway-probe/${randomUUID()}`;
    try {
      await client.checkHealth();
      await client.put({ key: probeKey, body: Buffer.alloc(6 * 1024 * 1024, 1) });
      await client.delete(probeKey);
      return { storage: client, kind: "rustfs" };
    } catch (error) {
      process.stderr.write(
        `\n  Drive S3 gateway e2e: S3 contract store ${endpoint} cannot store a 6 MiB object (${error instanceof Error ? error.message : String(error)}); using in-memory storage.\n`,
      );
    }
  }
  return { storage: new MemoryStorage(), kind: "memory" };
}
