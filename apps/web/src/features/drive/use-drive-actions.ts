/* Drive item operations with Workspace-style feedback: every reversible
   change (trash, move, rename) shows a snackbar with Undo, and failures
   show the server's actionable message. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { notify } from "@/components/ui/toast";
import {
  createDriveEntry,
  deleteDriveObject,
  moveDriveFolder,
  moveDriveObject,
  renameDriveObject,
  restoreDriveObject,
  setDriveObjectStarred,
  trashDriveObject,
} from "./api";
import { hideDriveShare } from "./drive-collaboration-api";
import type { DriveItem } from "./drive-data";
import { driveQueryKeys } from "./queries";

export interface DriveMoveTarget {
  readonly id: string | null;
  readonly name: string;
}

export interface DriveActions {
  readonly busy: boolean;
  trash(items: readonly DriveItem[]): Promise<void>;
  restore(items: readonly DriveItem[]): Promise<void>;
  deleteForever(items: readonly DriveItem[]): Promise<void>;
  move(items: readonly DriveItem[], target: DriveMoveTarget): Promise<void>;
  rename(item: DriveItem, name: string): Promise<void>;
  setStarred(items: readonly DriveItem[], starred: boolean): Promise<void>;
  /** Take items other people shared out of this person's Shared with me. */
  removeFromShared(items: readonly DriveItem[]): Promise<void>;
  createFolder(name: string, parentId: string | null): Promise<string | null>;
}

function countLabel(items: readonly DriveItem[]): string {
  if (items.length === 1) return `“${items[0]?.name ?? ""}”`;
  return `${String(items.length)} items`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function moveOne(item: DriveItem, folderId: string | null) {
  return item.kind === "folder"
    ? moveDriveFolder(item.id, folderId)
    : moveDriveObject(item.id, folderId);
}

export function useDriveActions(): DriveActions {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(0);
  const pendingRef = useRef(0);

  const run = useCallback(
    async <T>(work: () => Promise<T>, failure: string): Promise<T | null> => {
      pendingRef.current += 1;
      setPending(pendingRef.current);
      try {
        return await work();
      } catch (error) {
        notify({ message: failure, description: errorMessage(error, "Try again."), tone: "error" });
        return null;
      } finally {
        pendingRef.current -= 1;
        setPending(pendingRef.current);
        void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      }
    },
    [queryClient],
  );

  const restore = useCallback(
    async (items: readonly DriveItem[]) => {
      const done = await run(
        () => Promise.all(items.map((item) => restoreDriveObject(item.id))),
        "Couldn’t restore from trash",
      );
      if (done !== null) notify({ message: `${countLabel(items)} restored` });
    },
    [run],
  );

  const trash = useCallback(
    async (items: readonly DriveItem[]) => {
      if (items.length === 0) return;
      const done = await run(
        () => Promise.all(items.map((item) => trashDriveObject(item.id))),
        "Couldn’t move to trash",
      );
      if (done === null) return;
      notify({
        message: `${countLabel(items)} moved to trash`,
        action: {
          label: "Undo",
          onAction: () => {
            void run(
              () => Promise.all(items.map((item) => restoreDriveObject(item.id))),
              "Couldn’t undo",
            );
          },
        },
      });
    },
    [run],
  );

  const removeFromShared = useCallback(
    async (items: readonly DriveItem[]) => {
      if (items.length === 0) return;
      const hide = (hidden: boolean) =>
        Promise.all(items.map((item) => hideDriveShare(item.id, hidden)));
      const done = await run(() => hide(true), "Couldn’t remove from Shared with me");
      if (done === null) return;
      notify({
        message: `${countLabel(items)} removed from Shared with me`,
        description: "You still have access through a link.",
        action: {
          label: "Undo",
          onAction: () => {
            void run(() => hide(false), "Couldn’t undo");
          },
        },
      });
    },
    [run],
  );

  const deleteForever = useCallback(
    async (items: readonly DriveItem[]) => {
      if (items.length === 0) return;
      const done = await run(
        () => Promise.all(items.map((item) => deleteDriveObject(item.id))),
        "Couldn’t delete forever",
      );
      if (done !== null) notify({ message: `${countLabel(items)} deleted forever` });
    },
    [run],
  );

  const move = useCallback(
    async (items: readonly DriveItem[], target: DriveMoveTarget) => {
      const moving = items.filter((item) => item.folderId !== target.id && item.id !== target.id);
      if (moving.length === 0) return;
      const done = await run(
        () => Promise.all(moving.map((item) => moveOne(item, target.id))),
        "Couldn’t move",
      );
      if (done === null) return;
      notify({
        message: `${countLabel(moving)} moved to ${target.name}`,
        action: {
          label: "Undo",
          onAction: () => {
            void run(
              () => Promise.all(moving.map((item) => moveOne(item, item.folderId))),
              "Couldn’t undo the move",
            );
          },
        },
      });
    },
    [run],
  );

  const rename = useCallback(
    async (item: DriveItem, name: string) => {
      const next = name.trim();
      if (next.length === 0 || next === item.name) return;
      const done = await run(
        () => renameDriveObject({ objectId: item.id, name: next }),
        "Couldn’t rename",
      );
      if (done === null) return;
      notify({
        message: `Renamed to “${next}”`,
        action: {
          label: "Undo",
          onAction: () => {
            void run(
              () => renameDriveObject({ objectId: item.id, name: item.name }),
              "Couldn’t undo the rename",
            );
          },
        },
      });
    },
    [run],
  );

  const setStarred = useCallback(
    async (items: readonly DriveItem[], starred: boolean) => {
      const files = items.filter((item) => item.kind === "file");
      if (files.length === 0) return;
      await run(
        () => Promise.all(files.map((item) => setDriveObjectStarred(item.id, starred))),
        starred ? "Couldn’t add to starred" : "Couldn’t remove from starred",
      );
    },
    [run],
  );

  const createFolder = useCallback(
    async (name: string, parentId: string | null) => {
      const created = await run(
        () => createDriveEntry({ kind: "folder", name: name.trim(), folderId: parentId }),
        "Couldn’t create the folder",
      );
      return created?.id ?? null;
    },
    [run],
  );

  return useMemo(
    () => ({
      busy: pending > 0,
      trash,
      restore,
      deleteForever,
      move,
      rename,
      setStarred,
      removeFromShared,
      createFolder,
    }),
    [
      pending,
      trash,
      restore,
      deleteForever,
      move,
      rename,
      setStarred,
      removeFromShared,
      createFolder,
    ],
  );
}
