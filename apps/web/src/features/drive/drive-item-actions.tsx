/* The Drive item action model. The right-click menu, each row's ⋮ menu and
   the selection toolbar all read the same list, so they never disagree about
   what applies to the current selection. */
import {
  ClipboardCheck as WorkflowIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  EyeOff as HideIcon,
  FolderInput as MoveIcon,
  FolderOpen as OpenIcon,
  Info as InfoIcon,
  Link as LinkIcon,
  Pencil as RenameIcon,
  RotateCcw as RestoreIcon,
  Star as StarIcon,
  StarOff as UnstarIcon,
  Trash2 as TrashIcon,
  UserPlus as ShareIcon,
  type LucideIcon,
} from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { canDeleteForever, type DriveItem } from "./drive-data";

export type DriveActionId =
  | "open"
  | "download"
  | "share"
  | "copy-link"
  | "rename"
  | "copy"
  | "move"
  | "star"
  | "unstar"
  | "details"
  | "workflows"
  | "remove-shared"
  | "trash"
  | "restore"
  | "delete-forever";

export interface DriveAction {
  readonly id: DriveActionId;
  readonly label: string;
  readonly shortcut?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** Starts a new group (a separator is drawn above it). */
  readonly group: number;
}

const ACTION_ICONS: Readonly<Record<DriveActionId, LucideIcon>> = {
  open: OpenIcon,
  download: DownloadIcon,
  share: ShareIcon,
  "copy-link": LinkIcon,
  rename: RenameIcon,
  copy: CopyIcon,
  move: MoveIcon,
  star: StarIcon,
  unstar: UnstarIcon,
  details: InfoIcon,
  workflows: WorkflowIcon,
  "remove-shared": HideIcon,
  trash: TrashIcon,
  restore: RestoreIcon,
  "delete-forever": TrashIcon,
};

/** Actions that apply to `targets` (the selection, or the right-clicked item). */
export function driveItemActions(
  targets: readonly DriveItem[],
  context: {
    readonly trash: boolean;
    /** The targets are items other people shared, listed in Shared with me. */
    readonly shared?: boolean;
    readonly now?: number;
  },
): DriveAction[] {
  if (targets.length === 0) return [];
  const single = targets.length === 1 ? targets[0] : undefined;
  const files = targets.filter((item) => item.kind === "file");
  const onlyFiles = files.length === targets.length;
  const allAvailable = targets.every((item) => item.available);

  if (context.trash) {
    return [
      { id: "restore", label: "Restore", group: 0 },
      {
        id: "delete-forever",
        label: "Delete forever",
        destructive: true,
        disabled: !targets.every((item) => canDeleteForever(item, context.now)),
        group: 0,
      },
      ...(single === undefined
        ? []
        : [
            {
              id: "details" as const,
              label: single.kind === "folder" ? "Folder information" : "File information",
              shortcut: "a",
              group: 1,
            },
          ]),
    ];
  }

  const actions: DriveAction[] = [];
  if (single?.kind === "folder") {
    actions.push({ id: "open", label: "Open", shortcut: "Enter", group: 0 });
  }
  if (onlyFiles) {
    actions.push({
      id: "download",
      label: "Download",
      shortcut: single === undefined ? undefined : "Enter",
      disabled: !allAvailable,
      group: 0,
    });
  }
  if (single !== undefined) {
    actions.push(
      { id: "share", label: "Share", disabled: !single.available, group: 1 },
      { id: "copy-link", label: "Copy link", group: 1 },
      { id: "rename", label: "Rename", shortcut: "F2", group: 2 },
    );
  }
  if (onlyFiles) {
    actions.push({ id: "copy", label: "Make a copy", disabled: !allAvailable, group: 2 });
  }
  actions.push({ id: "move", label: "Move", group: 2 });
  if (onlyFiles) {
    const allStarred = files.every((item) => item.starred);
    actions.push(
      allStarred
        ? { id: "unstar", label: "Remove from starred", shortcut: "s", group: 2 }
        : {
            id: "star",
            label: "Add to starred",
            shortcut: "s",
            disabled: !allAvailable,
            group: 2,
          },
    );
  }
  if (single !== undefined) {
    actions.push(
      {
        id: "details",
        label: single.kind === "folder" ? "Folder information" : "File information",
        shortcut: "a",
        group: 3,
      },
      { id: "workflows", label: "Requests and approvals", group: 3 },
    );
  }
  if (context.shared === true) {
    // Someone else's item: it can leave this person's list, not the owner's Drive.
    actions.push({ id: "remove-shared", label: "Remove from Shared with me", group: 4 });
    return actions;
  }
  actions.push({
    id: "trash",
    label: "Move to trash",
    shortcut: "Delete",
    destructive: true,
    group: 4,
  });
  return actions;
}

function withSeparators(actions: readonly DriveAction[]) {
  return actions.map((action, index) => ({
    action,
    separated: index > 0 && actions[index - 1]?.group !== action.group,
  }));
}

/** Items for a right-click `ContextMenuContent`. */
export function DriveContextMenuItems({
  actions,
  onAction,
}: {
  readonly actions: readonly DriveAction[];
  readonly onAction: (id: DriveActionId) => void;
}) {
  return withSeparators(actions).map(({ action, separated }) => {
    const Icon = ACTION_ICONS[action.id];
    return [
      separated ? <ContextMenuSeparator key={`${action.id}-separator`} /> : null,
      <ContextMenuItem
        key={action.id}
        icon={<Icon size={16} />}
        shortcut={action.shortcut}
        destructive={action.destructive}
        disabled={action.disabled}
        onSelect={() => onAction(action.id)}
      >
        {action.label}
      </ContextMenuItem>,
    ];
  });
}

/** Items for a dropdown `MenuContent` (row ⋮ and the toolbar's More actions). */
export function DriveMenuItems({
  actions,
  onAction,
}: {
  readonly actions: readonly DriveAction[];
  readonly onAction: (id: DriveActionId) => void;
}) {
  return withSeparators(actions).map(({ action, separated }) => {
    const Icon = ACTION_ICONS[action.id];
    return [
      separated ? <MenuSeparator key={`${action.id}-separator`} /> : null,
      <MenuItem
        key={action.id}
        icon={<Icon size={16} />}
        shortcut={action.shortcut}
        destructive={action.destructive}
        disabled={action.disabled}
        onSelect={() => onAction(action.id)}
      >
        {action.label}
      </MenuItem>,
    ];
  });
}

export function driveActionIcon(id: DriveActionId): LucideIcon {
  return ACTION_ICONS[id];
}
