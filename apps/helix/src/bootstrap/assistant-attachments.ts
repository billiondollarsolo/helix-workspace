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

const FILE_BYTES = 512 * 1024;
const TOTAL_BYTES = 1024 * 1024;
const TOTAL_CHARACTERS = 100_000;

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
  if (ids.length > 5)
    throw new BadRequestError(
      "This conversation includes too many files. Start a new chat with up to 5 text or code files.",
    );
  let totalBytes = 0;
  let totalCharacters = 0;
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
    if (!isTextFile(mimeType, file.entry.name))
      throw new BadRequestError(
        `Cannot read ${file.entry.name}. Use text or code files; images, PDFs, and binary formats are not supported by this model.`,
      );
    if (file.byteSize > FILE_BYTES || totalBytes + file.byteSize > TOTAL_BYTES)
      throw new BadRequestError(
        "Use attachments up to 512 KiB each and 1 MiB total. Start a new chat with fewer or smaller files.",
      );
    const body = await file.open();
    if (body === null)
      throw new NotFoundError("The attached file's contents are unavailable. Upload it again.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let content = "";
    let fileBytes = 0;
    const decode = (chunk: Uint8Array) => {
      input.signal?.throwIfAborted();
      fileBytes += chunk.byteLength;
      totalBytes += chunk.byteLength;
      if (fileBytes > FILE_BYTES || totalBytes > TOTAL_BYTES)
        throw new BadRequestError(
          "Attachment contents exceed the 512 KiB per-file or 1 MiB total limit.",
        );
      try {
        content += decoder.decode(chunk, { stream: true });
      } catch {
        throw new BadRequestError(
          `Cannot read ${file.entry.name} as UTF-8 text. Save it as UTF-8 and upload it again.`,
        );
      }
      if (content.length + totalCharacters > TOTAL_CHARACTERS)
        throw new BadRequestError(
          "Attachment text exceeds 100,000 characters. Start a new chat with shorter files.",
        );
    };
    if (body instanceof Uint8Array) decode(body);
    else for await (const chunk of body) decode(chunk);
    try {
      content += decoder.decode();
    } catch {
      throw new BadRequestError(
        `Cannot read ${file.entry.name} as UTF-8 text. Save it as UTF-8 and upload it again.`,
      );
    }
    if (content.includes("\0"))
      throw new BadRequestError(
        `Cannot read ${file.entry.name}: it contains binary data. Upload a text or code file.`,
      );
    totalCharacters += content.length;
    if (totalCharacters > TOTAL_CHARACTERS)
      throw new BadRequestError(
        "Attachment text exceeds 100,000 characters. Start a new chat with shorter files.",
      );
    const resource = { orgId: input.actor.orgId, resourceType: "drive.file", resourceId: objectId };
    const classification = await options.classifications.get(resource);
    const decision = await options.dlp.evaluate({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      boundary: "api_agent",
      content,
      resources: [resource],
    });
    if (decision.action === "warn")
      throw new ForbiddenError(
        "An attached file requires policy acknowledgement before AI use. Remove it or ask an administrator to review its sharing policy.",
      );
    if (decision.action === "block" || decision.action === "quarantine")
      throw dlpDecisionError(decision);
    loaded.push({
      attachment: { objectId, name: file.entry.name, mimeType, byteSize: fileBytes },
      source: {
        id: objectId,
        type: "drive.attachment",
        title: file.entry.name,
        body: content,
        trust: "untrusted_retrieved",
        classification: maxClassification(
          maxClassification(classification?.classification ?? "standard", decision.classification),
          deriveClassification({ content, scanContent: true }).classification,
        ),
        provenance: {
          sourceId: objectId,
          sourceType: "drive.attachment",
          orgId: input.actor.orgId,
        },
      },
    });
  }
  return loaded;
}
