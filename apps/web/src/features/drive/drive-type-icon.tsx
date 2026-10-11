import {
  File as OtherIcon,
  FileArchive as ArchiveIcon,
  FileAudio as AudioIcon,
  FileCode as CodeIcon,
  FileImage as ImageIcon,
  FileSpreadsheet as SheetIcon,
  FileText as DocIcon,
  FileVideo as VideoIcon,
  Folder as FolderIcon,
  Presentation as SlidesIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DriveFileType } from "./drive-data";

/** Icon, label token color, and spoken name for each Drive type. */
export const DRIVE_TYPE_META: Readonly<
  Record<
    DriveFileType,
    { readonly icon: LucideIcon; readonly color: string; readonly label: string }
  >
> = {
  folder: { icon: FolderIcon, color: "var(--label-slate)", label: "Folder" },
  image: { icon: ImageIcon, color: "var(--label-pink)", label: "Image" },
  pdf: { icon: DocIcon, color: "var(--label-red)", label: "PDF" },
  doc: { icon: DocIcon, color: "var(--label-blue)", label: "Document" },
  sheet: { icon: SheetIcon, color: "var(--label-green)", label: "Spreadsheet" },
  slides: { icon: SlidesIcon, color: "var(--label-amber)", label: "Presentation" },
  audio: { icon: AudioIcon, color: "var(--label-purple)", label: "Audio" },
  video: { icon: VideoIcon, color: "var(--label-rose)", label: "Video" },
  archive: { icon: ArchiveIcon, color: "var(--label-brown)", label: "Archive" },
  code: { icon: CodeIcon, color: "var(--label-teal)", label: "Code" },
  other: { icon: OtherIcon, color: "var(--label-gray)", label: "File" },
};

/** Decorative type icon in the type's token color. Drive never renders file contents. */
export function DriveTypeIcon({
  type,
  size = 20,
  className,
}: {
  readonly type: DriveFileType;
  readonly size?: number;
  readonly className?: string;
}) {
  const meta = DRIVE_TYPE_META[type];
  const Icon = meta.icon;
  return (
    <Icon
      aria-hidden="true"
      size={size}
      className={cn("shrink-0", className)}
      style={{ color: meta.color }}
      fill={type === "folder" ? "currentColor" : "none"}
    />
  );
}
