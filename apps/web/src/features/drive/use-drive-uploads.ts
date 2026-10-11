/* Upload queue for the bottom-right upload panel. Each file goes through the
   existing direct-to-storage upload API, then waits for its malware scan:
   it reads "Scanning…" until the server marks it clean, and a quarantined or
   failed scan becomes a blocked row with the reason. Folder uploads recreate
   the folder tree with `drive.create` before uploading into it. */
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDriveEntry } from "./api";
import { driveQueryKeys, driveUploadStatusQueryOptions } from "./queries";
import { uploadDriveFile } from "./upload";
import { openDenialMessage } from "./upload-status-ui";

type DriveUploadPhase =
  "queued" | "uploading" | "scanning" | "done" | "blocked" | "failed" | "canceled";

export interface DriveUploadTask {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly uploadedBytes: number;
  readonly phase: DriveUploadPhase;
  /** Why the upload failed or was blocked. */
  readonly message: string | null;
  readonly objectId: string | null;
}

/** A file plus the folder it should land in. */
interface QueuedFile {
  readonly task: DriveUploadTask;
  readonly file: File;
  readonly folderId: string | null;
}

const CONCURRENCY = 2;

/** An actionable sentence for a failed upload; network failures get a plain-language hint. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return "Couldn’t reach Drive storage. Check your connection, then retry.";
  }
  return error instanceof Error && error.message.length > 0 ? error.message : "Upload failed.";
}

export function isUploadActive(task: Pick<DriveUploadTask, "phase">): boolean {
  return task.phase === "queued" || task.phase === "uploading" || task.phase === "scanning";
}

/** Directory paths a folder upload needs, parents first: "A", "A/B", "A/B/C". */
export function folderPathsForUpload(relativePaths: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const relativePath of relativePaths) {
    const parts = relativePath.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      paths.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...paths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function parentPath(relativePath: string): string {
  return relativePath.split("/").slice(0, -1).join("/");
}

let nextTaskId = 0;

export function useDriveUploads() {
  const queryClient = useQueryClient();
  const [tasks, setTasks] = useState<readonly DriveUploadTask[]>([]);
  const queueRef = useRef<QueuedFile[]>([]);
  const runningRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const failedRef = useRef(new Map<string, QueuedFile>());

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  const patch = useCallback((id: string, next: Partial<DriveUploadTask>) => {
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...next } : task)));
  }, []);

  // Uploaded files poll their scan status (the query stops once it is terminal).
  const scanning = tasks.filter((task) => task.phase === "scanning" && task.objectId !== null);
  const scans = useQueries({
    queries: scanning.map((task) => driveUploadStatusQueryOptions(task.objectId)),
  });
  useEffect(() => {
    let finished = false;
    scans.forEach((scan, index) => {
      const task = scanning[index];
      const status = scan.data;
      if (task === undefined || status === undefined || status.objectId !== task.objectId) return;
      if (status.available) {
        finished = true;
        patch(task.id, { phase: "done" });
      } else if (status.terminal) {
        finished = true;
        patch(task.id, { phase: "blocked", message: openDenialMessage(status.state) });
      }
    });
    if (finished) void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    // Finished tasks leave `scanning`, so re-running after every render is idempotent.
  }, [scans, scanning, patch, queryClient]);

  const pump = useCallback(() => {
    while (runningRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (next === undefined) return;
      const controller = controllersRef.current.get(next.task.id);
      if (controller === undefined || controller.signal.aborted) continue;
      runningRef.current += 1;
      patch(next.task.id, { phase: "uploading" });
      void (async () => {
        try {
          const uploaded = await uploadDriveFile({
            file: next.file,
            folderId: next.folderId,
            signal: controller.signal,
            onProgress: (uploadedBytes) => patch(next.task.id, { uploadedBytes }),
          });
          patch(next.task.id, {
            phase: "scanning",
            uploadedBytes: next.file.size,
            objectId: uploaded.objectId,
          });
          void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
          runningRef.current -= 1;
          pump();
        } catch (error) {
          runningRef.current -= 1;
          if (controller.signal.aborted) {
            patch(next.task.id, { phase: "canceled" });
          } else {
            failedRef.current.set(next.task.id, next);
            patch(next.task.id, { phase: "failed", message: uploadErrorMessage(error) });
          }
          pump();
        } finally {
          controllersRef.current.delete(next.task.id);
        }
      })();
    }
  }, [patch, queryClient]);

  const enqueue = useCallback(
    (entries: readonly { readonly file: File; readonly folderId: string | null }[]) => {
      const queued = entries.map(({ file, folderId }) => {
        nextTaskId += 1;
        const task: DriveUploadTask = {
          id: `upload-${String(nextTaskId)}`,
          name: file.name,
          size: file.size,
          uploadedBytes: 0,
          phase: "queued",
          message: null,
          objectId: null,
        };
        controllersRef.current.set(task.id, new AbortController());
        return { task, file, folderId };
      });
      setTasks((current) => [...current, ...queued.map((entry) => entry.task)]);
      queueRef.current.push(...queued);
      pump();
    },
    [pump],
  );

  const uploadFiles = useCallback(
    (files: readonly File[], folderId: string | null) => {
      enqueue(files.map((file) => ({ file, folderId })));
    },
    [enqueue],
  );

  /** Upload a picked folder (`webkitdirectory`), keeping its structure. */
  const uploadFolder = useCallback(
    async (files: readonly File[], folderId: string | null) => {
      const relative = (file: File) =>
        file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name;
      const folderIds = new Map<string, string | null>([["", folderId]]);
      try {
        for (const path of folderPathsForUpload(files.map(relative))) {
          const name = path.split("/").at(-1) ?? path;
          const created = await createDriveEntry({
            kind: "folder",
            name,
            folderId: folderIds.get(parentPath(path)) ?? folderId,
          });
          folderIds.set(path, created.id);
        }
      } catch (error) {
        nextTaskId += 1;
        setTasks((current) => [
          ...current,
          {
            id: `upload-${String(nextTaskId)}`,
            name: relative(files[0] ?? new File([], "Folder")).split("/")[0] ?? "Folder",
            size: 0,
            uploadedBytes: 0,
            phase: "failed",
            message: error instanceof Error ? error.message : "Couldn’t create the folders.",
            objectId: null,
          },
        ]);
        return;
      } finally {
        void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      }
      enqueue(
        files.map((file) => ({
          file,
          folderId: folderIds.get(parentPath(relative(file))) ?? folderId,
        })),
      );
    },
    [enqueue, queryClient],
  );

  const retry = useCallback(
    (id: string) => {
      const entry = failedRef.current.get(id);
      if (entry === undefined) return;
      failedRef.current.delete(id);
      controllersRef.current.set(id, new AbortController());
      patch(id, { phase: "queued", message: null, uploadedBytes: 0 });
      queueRef.current.push(entry);
      pump();
    },
    [patch, pump],
  );

  const cancel = useCallback((id: string) => {
    controllersRef.current.get(id)?.abort();
    queueRef.current = queueRef.current.filter((entry) => entry.task.id !== id);
    setTasks((current) =>
      current.map((task) =>
        task.id === id && (task.phase === "queued" || task.phase === "uploading")
          ? { ...task, phase: "canceled" }
          : task,
      ),
    );
  }, []);

  /** Close the panel: cancels anything still uploading and forgets the list. */
  const clear = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    failedRef.current.clear();
    queueRef.current = [];
    setTasks([]);
  }, []);

  return useMemo(
    () => ({ tasks, uploadFiles, uploadFolder, retry, cancel, clear }),
    [tasks, uploadFiles, uploadFolder, retry, cancel, clear],
  );
}
