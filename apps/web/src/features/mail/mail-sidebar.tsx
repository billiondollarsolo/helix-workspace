import { iconMap as Icons, type IconName } from "@/components/icon-map";
import { Pencil as EditPenIcon } from "lucide-react";
import { type MailFolderKey, type MailFolderSummary, type MailLabelSummary } from "./api";

/* ----------------------------------------------------------- icons + time */

/** Static folder → icon map; the backend `mail.folders.list` is icon-free. */
const FOLDER_ICONS: Readonly<Record<MailFolderKey, IconName>> = {
  inbox: "Inbox",
  starred: "Star",
  snoozed: "Snooze",
  sent: "Send",
  drafts: "EditPen",
  archive: "Archive",
  spam: "Bell",
  held: "Shield",
  trash: "Trash",
};

/** Folder display order in the left rail. Spam is first-class (always listed). */
const FOLDER_ORDER: readonly MailFolderKey[] = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "archive",
  "spam",
  "held",
  "trash",
];

/* ----------------------------------------------------------------- sidebar */

interface MailSidebarProps {
  readonly folder: MailFolderKey;
  readonly onFolder: (folder: MailFolderKey) => void;
  readonly onCompose: () => void;
  readonly folders: readonly MailFolderSummary[];
  readonly labels: readonly MailLabelSummary[];
  readonly activeLabel: string | null;
  readonly onLabel: (label: string | null) => void;
}

export function MailSidebar({
  folder,
  onFolder,
  onCompose,
  folders,
  labels,
  activeLabel,
  onLabel,
}: MailSidebarProps) {
  const byId = new Map(folders.map((entry) => [entry.id, entry]));
  const ordered = FOLDER_ORDER.map((id) => byId.get(id)).filter(
    (entry): entry is MailFolderSummary => entry != null,
  );
  // Folder and label are exclusive views: never highlight both.
  const folderActiveId = activeLabel === null ? folder : null;

  return (
    <aside className="surf-sidebar">
      <button
        type="button"
        className="btn primary lg w-full mb-3"

        onClick={onCompose}
      >
        <EditPenIcon size={16} /> Compose
      </button>
      <div className="overflow-y-auto flex-1">
        {ordered.map((entry) => {
          const Icon = Icons[FOLDER_ICONS[entry.id]];
          const active = folderActiveId === entry.id;
          const badge = entry.id === "inbox" ? entry.unread : entry.total;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onFolder(entry.id)}
              aria-current={active ? "page" : undefined}
              className="surf-nav-row"
            >
              <Icon size={16} />
              <span className="label">{entry.label}</span>
              {badge > 0 && <span className="count">{badge}</span>}
            </button>
          );
        })}
        <div className="surf-section-label">Labels</div>
        {labels.map((label) => {
          const active = activeLabel === label.slug;
          return (
            <button
              key={label.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onLabel(active ? null : label.slug)}
              className="surf-nav-row"
            >
              <span
                className="w-2 h-2 [border-radius:2px] shrink-0"
                style={{ background: label.color }}
              />
              <span className="label">{label.name}</span>
              {label.threadCount > 0 && <span className="count">{label.threadCount}</span>}
            </button>
          );
        })}
        <div className="surf-section-label">Filters</div>
        <div className="[padding:0_var(--nav-row-px)]">
          <span className="chip">has:attachment</span>
        </div>
      </div>
    </aside>
  );
}
