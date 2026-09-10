import { MailDeliveryError } from "../platform/mail/index.js";

export async function collectBoundedBytes(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit)
      throw new MailDeliveryError("Drive attachment exceeds the outbound mail limit.", false);
    return Buffer.from(body);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new MailDeliveryError("Drive attachment exceeds the outbound mail limit.", false);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
