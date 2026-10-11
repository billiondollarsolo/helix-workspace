/* Attachments for a Chat message being written: images uploaded to the
   conversation (scanned by the server before they are usable) and files
   picked from Drive. */

import { listDrive, type DriveApiEntry } from "@/features/drive/api";
import { useEffect, useState } from "react";
import { uploadChatAttachment, type ChatAttachmentRecord } from "./api";

const MAX_ATTACHMENTS = 10;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const CHAT_IMAGE_ACCEPT = [...IMAGE_TYPES].join(",");

export function useComposerAttachments(roomId: string | undefined, disabled: boolean) {
  const [attachments, setAttachments] = useState<readonly ChatAttachmentRecord[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState<readonly DriveApiEntry[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);

  useEffect(() => {
    setAttachments([]);
    setError(null);
    setDriveOpen(false);
  }, [roomId]);

  const upload = async (files: readonly File[]) => {
    if (roomId === undefined || disabled) return;
    const available = MAX_ATTACHMENTS - attachments.length;
    if (available <= 0) {
      setError(`A message can contain at most ${String(MAX_ATTACHMENTS)} attachments.`);
      return;
    }
    const selected = files.slice(0, available);
    const invalid = selected.find(
      (file) => !IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_UPLOAD_BYTES,
    );
    if (invalid !== undefined) {
      setError("Upload a PNG, JPEG, GIF, or WebP image no larger than 10 MiB.");
      return;
    }
    setError(null);
    setUploading((count) => count + selected.length);
    const results = await Promise.allSettled(
      selected.map((file) => uploadChatAttachment(roomId, file)),
    );
    setUploading((count) => count - selected.length);
    const uploaded = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (uploaded.length > 0) {
      setAttachments((current) => uniqueAttachments([...current, ...uploaded]));
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) {
      const reason: unknown = failure.reason;
      setError(
        reason instanceof Error && reason.message.length > 0
          ? reason.message
          : "One or more images could not be uploaded.",
      );
    }
  };

  const toggleDrive = () => {
    const opening = !driveOpen;
    setDriveOpen(opening);
    if (!opening || driveFiles.length > 0) return;
    setDriveLoading(true);
    setError(null);
    void listDrive({ acrossFolders: true, limit: 30 })
      .then((page) => setDriveFiles(page.entries))
      .catch(() => setError("Drive files could not be loaded. Try again."))
      .finally(() => setDriveLoading(false));
  };

  const attachDriveFile = (file: DriveApiEntry) => {
    if (attachments.length >= MAX_ATTACHMENTS) {
      setError(`A message can contain at most ${String(MAX_ATTACHMENTS)} attachments.`);
      return;
    }
    setAttachments((current) =>
      uniqueAttachments([
        ...current,
        {
          objectId: file.id,
          source: "drive",
          filename: file.name,
          mimeType: file.mimeType ?? "application/octet-stream",
          byteSize: Math.max(1, file.byteSize ?? 1),
        },
      ]),
    );
    setDriveOpen(false);
  };

  return {
    attachments,
    uploading,
    error,
    setError,
    driveOpen,
    driveFiles,
    driveLoading,
    upload,
    toggleDrive,
    attachDriveFile,
    remove: (objectId: string) =>
      setAttachments((current) => current.filter((item) => item.objectId !== objectId)),
    clear: () => {
      setAttachments([]);
      setError(null);
    },
  };
}

function uniqueAttachments(
  attachments: readonly ChatAttachmentRecord[],
): readonly ChatAttachmentRecord[] {
  return [...new Map(attachments.map((attachment) => [attachment.objectId, attachment])).values()];
}
