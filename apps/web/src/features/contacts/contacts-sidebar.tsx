/* Contacts left navigation: Create contact, the contact and directory
   lists, Merge and fix, Import, Trash, and labels with counts and a ⋮ menu. */
import type { ContactLabel } from "@helix/contracts";
import {
  Building2 as DirectoryIcon,
  Download as ImportIcon,
  GitMerge as MergeIcon,
  MoreVertical as MoreIcon,
  Pencil as RenameIcon,
  Plus as PlusIcon,
  Tag as LabelIcon,
  Trash2 as TrashIcon,
  UserPlus as CreateIcon,
  Users as ContactsIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import type { ContactsLocation } from "./route-location";
import type { ContactListView } from "./route-search";

interface ContactsSidebarProps {
  readonly location: ContactsLocation;
  readonly contactCount: number | undefined;
  readonly duplicateCount: number | undefined;
  readonly labels: readonly ContactLabel[];
  readonly onNavigate: (location: ContactsLocation) => void;
  readonly onCreate: () => void;
  readonly onImport: () => void;
  readonly onCreateLabel: () => void;
  readonly onRenameLabel: (name: string) => void;
  readonly onDeleteLabel: (name: string) => void;
}

function NavRow({
  icon: Icon,
  label,
  count,
  current,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count?: number | undefined;
  readonly current?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="surf-nav-row"
      aria-current={current === true ? "page" : undefined}
      onClick={onClick}
    >
      <Icon size={18} aria-hidden="true" />
      <span className="label">{label}</span>
      {count === undefined || count === 0 ? null : (
        <span className="count">{count.toLocaleString()}</span>
      )}
    </button>
  );
}

export function ContactsSidebar(props: ContactsSidebarProps) {
  const { location } = props;
  const isView = (view: ContactListView) => location.kind === "view" && location.view === view;
  const go = (view: ContactListView) => props.onNavigate({ kind: "view", view });

  return (
    <aside className="surf-sidebar contacts-sidebar" aria-label="Contacts navigation">
      <button type="button" className="btn primary contacts-create" onClick={props.onCreate}>
        <CreateIcon size={20} aria-hidden="true" />
        Create contact
      </button>
      <nav aria-label="Contact lists" className="flex flex-col gap-[var(--sidebar-gap)]">
        <NavRow
          icon={ContactsIcon}
          label="Contacts"
          count={props.contactCount}
          current={isView("contacts")}
          onClick={() => go("contacts")}
        />
        <NavRow
          icon={DirectoryIcon}
          label="Directory"
          current={isView("directory")}
          onClick={() => go("directory")}
        />
      </nav>
      <h2 className="surf-section-label m-0">Fix and manage</h2>
      <nav aria-label="Fix and manage" className="flex flex-col gap-[var(--sidebar-gap)]">
        <NavRow
          icon={MergeIcon}
          label="Merge and fix"
          count={props.duplicateCount}
          current={isView("merge")}
          onClick={() => go("merge")}
        />
        <NavRow icon={ImportIcon} label="Import" onClick={props.onImport} />
        <NavRow
          icon={TrashIcon}
          label="Trash"
          current={isView("trash")}
          onClick={() => go("trash")}
        />
      </nav>
      <div className="contacts-labels-head">
        <h2 className="surf-section-label m-0">Labels</h2>
        <button
          type="button"
          className="contacts-icon-button focus-ring"
          aria-label="Create label"
          title="Create label"
          onClick={props.onCreateLabel}
        >
          <PlusIcon aria-hidden="true" />
        </button>
      </div>
      <nav aria-label="Labels" className="flex flex-col gap-[var(--sidebar-gap)]">
        {props.labels.map((label) => (
          <div key={label.name} className="contacts-label-item">
            <NavRow
              icon={LabelIcon}
              label={label.name}
              count={label.count}
              current={location.kind === "label" && location.label === label.name}
              onClick={() => props.onNavigate({ kind: "label", label: label.name })}
            />
            <Menu>
              <MenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="contacts-icon-button text-muted-foreground contacts-label-menu focus-ring"
                  aria-label={`Options for ${label.name}`}
                >
                  <MoreIcon aria-hidden="true" />
                </Button>
              </MenuTrigger>
              <MenuContent align="start" aria-label={`Options for ${label.name}`}>
                <MenuItem icon={<RenameIcon />} onSelect={() => props.onRenameLabel(label.name)}>
                  Rename label
                </MenuItem>
                <MenuItem
                  icon={<TrashIcon />}
                  destructive
                  onSelect={() => props.onDeleteLabel(label.name)}
                >
                  Delete label
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        ))}
      </nav>
    </aside>
  );
}
