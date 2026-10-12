/* Compose attachments: each file uploads to Drive storage, then waits for the
   malware scan. The chip shows upload progress and the scan result; a
   blocked or failed file stops Send until it is removed. */

import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trashDriveObject } from "@/features/drive/api";
import { driveUploadStatusQueryOptions } from "@/features/drive/queries";
import { uploadDriveFile } from "@/features/drive/upload";
import { validateMailAttachmentSelection, type MailAttachment } from "../api";
import { randomId } from "@/lib/random-id";

type AttachmentState = "uploading" | "scanning" | "ready" | "blocked" | "failed";

export interface ComposeAttachmentItem {
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly objectId: string | null;
  readonly state: AttachmentState;
  /** Status text for the chip, e.g. "Scanning for malware". */
  readonly detail: string;
  /** Whole-number percent sent to storage while uploading; null otherwise. */
  readonly progress: number | null;
}

interface UploadEntry {
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly objectId: string | null;
  readonly uploadedBytes: number;
  /** Uploaded by this window, so its scan is watched and a discard trashes it. */
  readonly fresh: boolean;
  readonly failure: string | null;
}

function fromAttachment(attachment: MailAttachment): UploadEntry {
  return {
    key: attachment.objectId,
    filename: attachment.filename ?? "Attachment",
    contentType: attachment.contentType ?? "application/octet-stream",
    byteSize: attachment.byteSize ?? 0,
    objectId: attachment.objectId,
    uploadedBytes: attachment.byteSize ?? 0,
    fresh: false,
    failure: null,
  };
}

export function attachmentsForSend(items: readonly ComposeAttachmentItem[]): MailAttachment[] {
  return items.flatMap((item) =>
    item.objectId === null || item.state === "failed" || item.state === "blocked"
      ? []
      : [
          {
            objectId: item.objectId,
            filename: item.filename,
            contentType: item.contentType,
            byteSize: item.byteSize,
          },
        ],
  );
}

/** Why attachments block Send, or null. */
export function attachmentProblem(items: readonly ComposeAttachmentItem[]): string | null {
  const uploading = items.find((item) => item.state === "uploading");
  if (uploading !== undefined) return `Wait for ${uploading.filename} to finish uploading.`;
  const blocked = items.find((item) => item.state === "blocked" || item.state === "failed");
  if (blocked !== undefined) return `Remove ${blocked.filename} to send: ${blocked.detail}.`;
  return null;
}

export function useComposeAttachments(initial: readonly MailAttachment[]) {
  const [entries, setEntries] = useState<readonly UploadEntry[]>(() => initial.map(fromAttachment));
  const [error, setError] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
    };
  }, []);

  const scans = useQueries({
    queries: entries.map((entry) =>
      driveUploadStatusQueryOptions(entry.fresh ? entry.objectId : null),
    ),
  });

  const items = useMemo<readonly ComposeAttachmentItem[]>(
    () =>
      entries.map((entry, index) => {
        const base = {
          key: entry.key,
          filename: entry.filename,
          contentType: entry.contentType,
          byteSize: entry.byteSize,
          objectId: entry.objectId,
          progress: null,
        };
        if (entry.failure !== null) return { ...base, state: "failed", detail: entry.failure };
        if (entry.objectId === null) {
          const progress =
            entry.byteSize === 0
              ? 0
              : Math.min(100, Math.floor((entry.uploadedBytes / entry.byteSize) * 100));
          return { ...base, state: "uploading", detail: "Uploading", progress };
        }
        if (!entry.fresh) return { ...base, state: "ready", detail: "" };
        const status = scans[index]?.data;
        if (status === undefined || !status.terminal) {
          return { ...base, state: "scanning", detail: status?.label ?? "Scanning for malware" };
        }
        return status.available
          ? { ...base, state: "ready", detail: "" }
          : { ...base, state: "blocked", detail: status.label };
      }),
    [entries, scans],
  );

  const patch = useCallback((key: string, next: Partial<UploadEntry>) => {
    setEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)),
    );
  }, []);

  const add = useCallback(
    (files: FileList | readonly File[]) => {
      const selected = Array.from(files);
      if (selected.length === 0) return;
      const policyError = validateMailAttachmentSelection(
        entries.map((entry) => ({
          objectId: entry.objectId ?? entry.key,
          byteSize: entry.byteSize,
        })),
        selected,
      );
      setError(policyError);
      if (policyError !== null) return;
      for (const file of selected) {
        const key = randomId();
        const controller = new AbortController();
        controllers.current.set(key, controller);
        setEntries((current) => [
          ...current,
          {
            key,
            filename: file.name,
            contentType: file.type === "" ? "application/octet-stream" : file.type,
            byteSize: file.size,
            objectId: null,
            uploadedBytes: 0,
            fresh: true,
            failure: null,
          },
        ]);
        void uploadDriveFile({
          file,
          folderId: null,
          signal: controller.signal,
          onProgress: (uploadedBytes) => {
            patch(key, { uploadedBytes });
          },
        })
          .then((result) => {
            patch(key, { objectId: result.objectId });
          })
          .catch((uploadError: unknown) => {
            if (controller.signal.aborted) return;
            patch(key, {
              failure:
                uploadError instanceof Error ? uploadError.message : "The upload didn't finish",
            });
          })
          .finally(() => {
            controllers.current.delete(key);
          });
      }
    },
    [entries, patch],
  );

  const remove = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setError(null);
    setEntries((current) => {
      const entry = current.find((candidate) => candidate.key === key);
      if (entry?.fresh === true && entry.objectId !== null) {
        void trashDriveObject(entry.objectId).catch(() => undefined);
      }
      return current.filter((candidate) => candidate.key !== key);
    });
  }, []);

  /** Ids this window uploaded; trashed when a discard becomes final. */
  const freshObjectIds = useCallback(
    () =>
      entries.flatMap((entry) => (entry.fresh && entry.objectId !== null ? [entry.objectId] : [])),
    [entries],
  );

  const replace = useCallback((next: readonly MailAttachment[]) => {
    setEntries(next.map(fromAttachment));
  }, []);

  return { items, error, add, remove, replace, freshObjectIds };
}

/** Trash uploads that belonged to a discarded message. */
export function trashUploads(objectIds: readonly string[]): void {
  for (const objectId of objectIds) void trashDriveObject(objectId).catch(() => undefined);
}
