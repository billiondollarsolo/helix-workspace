import {
  FileUp as FileUploadIcon,
  FolderPlus as NewFolderIcon,
  FolderUp as FolderUploadIcon,
  Plus as PlusIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { DriveMenuButton } from "./drive-menu-button";

export interface DriveNewActions {
  readonly onNewFolder: () => void;
  readonly onFileUpload: () => void;
  readonly onFolderUpload: () => void;
}

/** "New folder / File upload / Folder upload" — the body of every New menu. */
export function DriveNewMenuItems({ onNewFolder, onFileUpload, onFolderUpload }: DriveNewActions) {
  return (
    <>
      <MenuItem icon={<NewFolderIcon size={16} />} shortcut="n" onSelect={onNewFolder}>
        New folder
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<FileUploadIcon size={16} />} shortcut="⇧U" onSelect={onFileUpload}>
        File upload
      </MenuItem>
      <MenuItem icon={<FolderUploadIcon size={16} />} shortcut="⇧I" onSelect={onFolderUpload}>
        Folder upload
      </MenuItem>
    </>
  );
}

function DriveNewMenu({
  trigger,
  align = "start",
  side,
  ...actions
}: DriveNewActions & {
  readonly trigger: ReactNode;
  readonly align?: "start" | "end";
  readonly side?: "top" | "bottom";
}) {
  return (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent align={align} side={side} className="min-w-56">
        <DriveNewMenuItems {...actions} />
      </MenuContent>
    </Menu>
  );
}

/** The sidebar's "New" button. */
export function DriveNewButton(props: DriveNewActions & { readonly disabled?: boolean }) {
  return (
    <DriveNewMenu
      {...props}
      trigger={
        <DriveMenuButton className="drive-new-button" disabled={props.disabled}>
          <PlusIcon size={22} aria-hidden="true" />
          New
        </DriveMenuButton>
      }
    />
  );
}

/** Mobile floating "New" button, bottom-right. */
export function DriveNewFab(props: DriveNewActions) {
  return (
    <DriveNewMenu
      {...props}
      align="end"
      side="top"
      trigger={
        <DriveMenuButton className="drive-fab" aria-label="New" data-testid="drive-fab">
          <PlusIcon size={24} aria-hidden="true" />
        </DriveMenuButton>
      }
    />
  );
}
