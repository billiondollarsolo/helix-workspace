import type { Actor } from "@helix/sdk-types";
import { BadRequestError, ForbiddenError, NotFoundError } from "../api/api-error.js";
import { requireActorScope } from "../api/scopes.js";
import {
  deriveClassification,
  maxClassification,
  type ResourceClassificationService,
} from "../platform/ai/classification/index.js";
import type { AssistantLoadedAttachment } from "../platform/assistant/types.js";
import { dlpDecisionError, type DlpGuard } from "../platform/dlp.js";
import type { PostgresDriveStore } from "../platform/drive/index.js";
import { isTextFile } from "../platform/drive/text-content.js";
import { assistantAttachmentLimits } from "../platform/assistant/attachment-limits.js";
import {
  extractPdfText,
  imageMimeType,
  isImageFile,
  isPdfFile,
} from "../platform/assistant/media.js";

const { maxFiles, maxFileBytes, maxTotalBytes, maxBodyChars, scanChars } =
  assistantAttachmentLimits;

/** Reads only actor-authorized, scan-clean Drive bytes; attachments never become trusted instructions. */
export async function loadAssistantAttachments(
  options: {
    readonly driveStore: Pick<PostgresDriveStore, "openFile" | "canExportFile">;
    readonly classifications: Pick<ResourceClassificationService, "get">;
    readonly dlp: DlpGuard;
  },
  input: {
    readonly actor: Actor;
    readonly objectIds: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<readonly AssistantLoadedAttachment[]> {
  requireActorScope(input.actor, "drive.read");
  const ids = [...new Set(input.objectIds)];
  if (ids.length > maxFiles)
    throw new BadRequestError(
      `This conversation includes too many files. Start a new chat with up to ${String(maxFiles)} attachments.`,
    );
  let totalBytes = 0;
  const loaded: AssistantLoadedAttachment[] = [];
  for (const objectId of ids) {
    input.signal?.throwIfAborted();
    const ref = { orgId: input.actor.orgId, actorId: input.actor.id, objectId };
    const file = await options.driveStore.openFile(ref);
    if (file === null)
      throw new NotFoundError(
        "An attached file is unavailable. Check its access and scan status in Drive, or start a new chat without it.",
      );
    if (file.orgId !== undefined && file.orgId !== input.actor.orgId)
      throw new NotFoundError("Attached file not found.");
    // Legacy objects without lifecycle metadata are readable in Drive, but cannot bypass scanning here.
    if (file.entry.metadata.status !== "ready" || file.entry.deletedAt !== null)
      throw new BadRequestError(
        "An attached file has not passed scanning. Wait for the scan or upload it again in Drive.",
      );
    if (!(await options.driveStore.canExportFile(ref)))
      throw new ForbiddenError("Export of an attached file is disabled.");
    const mimeType =
      (file.entry.mimeType ?? "application/octet-stream").split(";", 1)[0]?.toLowerCase() ??
      "application/octet-stream";
    const image = isImageFile(mimeType, file.entry.name);
    const pdf = isPdfFile(mimeType, file.entry.name);
    if (!isTextFile(mimeType, file.entry.name) && !image && !pdf)
      throw new BadRequestError(`Cannot read ${file.entry.name}. Use text, code, images, or PDFs.`);
    if (file.byteSize > maxFileBytes || totalBytes + file.byteSize > maxTotalBytes)
      throw new BadRequestError(
        "Use attachments up to 10 MB each and 25 MB total. Start a new chat with fewer or smaller files.",
      );
    const body = await file.open();
    if (body === null)
      throw new NotFoundError("The attached file's contents are unavailable. Upload it again.");
    const bytes = await readAttachmentBytes(body, maxFileBytes, () => {
      input.signal?.throwIfAborted();
    });
    if (bytes.byteLength > maxFileBytes || totalBytes + bytes.byteLength > maxTotalBytes)
      throw new BadRequestError(
        "Attachment contents exceed the 10 MB per-file or 25 MB total limit.",
      );
    totalBytes += bytes.byteLength;
    let content: string;
    let media: { mimeType: string; data: string } | undefined;
    if (image) {
      media = {
        mimeType: imageMimeType(mimeType, file.entry.name),
        data: Buffer.from(bytes).toString("base64"),
      };
      content = `Image attachment ${file.entry.name} (${String(bytes.byteLength)} bytes).`;
    } else if (pdf) {
      const extracted = extractPdfText(bytes);
      content =
        extracted.length > 0
          ? extracted
          : `PDF attachment ${file.entry.name} (${String(bytes.byteLength)} bytes) with no extractable text. Ask for a screenshot if you need to see the page.`;
    } else {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new BadRequestError(
          `Cannot read ${file.entry.name} as UTF-8 text. Save it as UTF-8 and upload it again.`,
        );
      }
      if (content.includes("\0"))
        throw new BadRequestError(
          `Cannot read ${file.entry.name}: it contains binary data. Upload a text, image, or PDF file.`,
        );
    }
    if (content.length > maxBodyChars)
      content = `${content.slice(0, maxBodyChars)}\n\n[Truncated. Use context.view to page this attachment.]`;
    const scanContent = content.slice(0, scanChars);
    const resource = { orgId: input.actor.orgId, resourceType: "drive.file", resourceId: objectId };
    const classification = await options.classifications.get(resource);
    const decision = await options.dlp.evaluate({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      boundary: "api_agent",
      content: scanContent,
      resources: [resource],
    });
    if (decision.action === "warn")
      throw new ForbiddenError(
        "An attached file requires policy acknowledgement before AI use. Remove it or ask an administrator to review its sharing policy.",
      );
    if (decision.action === "block" || decision.action === "quarantine")
      throw dlpDecisionError(decision);
    loaded.push({
      attachment: { objectId, name: file.entry.name, mimeType, byteSize: bytes.byteLength },
      source: {
        id: objectId,
        type: "drive.attachment",
        title: file.entry.name,
        body: content,
        trust: "untrusted_retrieved",
        classification: maxClassification(
          maxClassification(classification?.classification ?? "standard", decision.classification),
          deriveClassification({ content: scanContent, scanContent: true }).classification,
        ),
        provenance: {
          sourceId: objectId,
          sourceType: "drive.attachment",
          orgId: input.actor.orgId,
        },
        ...(media === undefined ? {} : { media }),
      },
    });
  }
  return loaded;
}

async function readAttachmentBytes(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  maxBytes: number,
  onChunk: () => void,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes)
      throw new BadRequestError(
        "Attachment contents exceed the 10 MB per-file or 25 MB total limit.",
      );
    return body;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    onChunk();
    size += chunk.byteLength;
    if (size > maxBytes)
      throw new BadRequestError(
        "Attachment contents exceed the 10 MB per-file or 25 MB total limit.",
      );
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
