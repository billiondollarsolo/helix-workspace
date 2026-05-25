import { authenticatedFetch } from "@/lib/auth";
import { uploadDriveFile, type DriveUploadResult } from "@/features/drive/api";
import { callTool } from "@/lib/tool-call";

export type PdfApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type PdfCommentStatus = "open" | "resolved" | "all";
type PdfCommentRecordStatus = Exclude<PdfCommentStatus, "all">;

export interface PdfFormStateFieldValue {
  readonly name: string;
  readonly type?: "text" | "checkbox" | "choice" | "signature" | "unsupported";
  readonly value: string | boolean;
}

export interface PdfFormState {
  readonly objectId: string;
  readonly actorId: string;
  readonly fieldValues: readonly PdfFormStateFieldValue[];
  readonly sourceVersionNumber: number | null;
  readonly sourceSha256: string | null;
  readonly sourceByteSize: number | null;
  readonly sourceChanged: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PdfDriveComment {
  readonly id: string;
  readonly objectId: string;
  readonly parentCommentId?: string | null;
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly body: string;
  readonly status: PdfCommentRecordStatus;
  readonly metadata: Record<string, unknown>;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly author?: {
    readonly id: string;
    readonly displayName?: string;
    readonly email?: string;
  };
}

export async function listPdfComments(
  input: { readonly objectId: string; readonly status?: PdfCommentStatus },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<readonly PdfDriveComment[]> {
  const output = await callPdfTool<{ readonly comments?: readonly PdfDriveComment[] }>(
    "drive.comment.list",
    {
      objectId: input.objectId,
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    fetchImpl,
  );
  return output.comments ?? [];
}

export async function createPdfComment(
  input: {
    readonly objectId: string;
    readonly body: string;
    readonly anchor: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
    readonly parentCommentId?: string;
  },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfDriveComment> {
  return callPdfTool<PdfDriveComment>(
    "drive.comment.create",
    {
      objectId: input.objectId,
      body: input.body,
      anchor: input.anchor,
      metadata: input.metadata ?? {},
      ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
    },
    fetchImpl,
  );
}

export async function resolvePdfComment(
  input: { readonly commentId: string },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfDriveComment> {
  return callPdfTool<PdfDriveComment>("drive.comment.resolve", input, fetchImpl);
}

export async function reopenPdfComment(
  input: { readonly commentId: string },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfDriveComment> {
  return callPdfTool<PdfDriveComment>("drive.comment.reopen", input, fetchImpl);
}

export async function updatePdfComment(
  input: { readonly commentId: string; readonly body: string },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfDriveComment> {
  return callPdfTool<PdfDriveComment>("drive.comment.update", input, fetchImpl);
}

export async function deletePdfComment(
  input: { readonly commentId: string },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfDriveComment> {
  return callPdfTool<PdfDriveComment>("drive.comment.delete", input, fetchImpl);
}

export async function getPdfFormState(
  input: { readonly objectId: string },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfFormState | null> {
  const output = await callPdfTool<{ readonly state?: PdfFormState | null }>(
    "drive.pdfFormState.get",
    input,
    fetchImpl,
  );
  return output.state ?? null;
}

export async function savePdfFormState(
  input: {
    readonly objectId: string;
    readonly fields: readonly PdfFormStateFieldValue[];
  },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<PdfFormState> {
  return callPdfTool<PdfFormState>(
    "drive.pdfFormState.save",
    {
      objectId: input.objectId,
      fields: input.fields,
    },
    fetchImpl,
  );
}

export async function clearPdfFormState(
  input: { readonly objectId: string },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<{ readonly objectId: string; readonly cleared: boolean }> {
  return callPdfTool<{ readonly objectId: string; readonly cleared: boolean }>(
    "drive.pdfFormState.clear",
    input,
    fetchImpl,
  );
}

export async function savePdfCopyToDrive(
  input: {
    readonly filename: string;
    readonly blob: Blob;
    readonly folderId?: string | null;
  },
  fetchImpl: PdfApiFetch = authenticatedFetch,
): Promise<DriveUploadResult> {
  const file = new File([input.blob], input.filename, {
    type: input.blob.type || "application/pdf",
  });
  return uploadDriveFile({ file, folderId: input.folderId ?? null }, fetchImpl);
}

async function callPdfTool<T>(
  toolId: string,
  input: Record<string, unknown>,
  fetchImpl: PdfApiFetch,
): Promise<T> {
  return callTool<T>(toolId, input, { fetchImpl });
}
