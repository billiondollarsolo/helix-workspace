/* Above the contact list: the title and count, then either the selection
   actions (labels, export, delete) or the list actions (sort, export). */
import type { Contact, ContactLabel } from "@helix/contracts";
import {
  ArrowDownAZ as SortIcon,
  Download as ExportIcon,
  Plus as PlusIcon,
  Tag as LabelIcon,
  Trash2 as TrashIcon,
  X as ClearIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import type { ReactNode } from "react";
import type { ContactSortOrder } from "./model";

/** For each label, whether all, some or none of `selected` carry it. */
function labelStates(
  labels: readonly ContactLabel[],
  selected: readonly Contact[],
): ReadonlyMap<string, boolean | "indeterminate"> {
  return new Map(
    labels.map((label) => {
      const carrying = selected.filter((contact) =>
        contact.labels.some((name) => name.toLocaleLowerCase() === label.name.toLocaleLowerCase()),
      ).length;
      return [
        label.name,
        carrying === 0 ? false : carrying === selected.length ? true : "indeterminate",
      ] as const;
    }),
  );
}

export function SelectionToolbar({
  leading,
  selected,
  labels,
  onClear,
  onLabel,
  onCreateLabel,
  onExport,
  onDelete,
}: {
  /** The page title and select-all checkbox. */
  readonly leading: ReactNode;
  readonly selected: readonly Contact[];
  readonly labels: readonly ContactLabel[];
  readonly onClear: () => void;
  readonly onLabel: (label: string, add: boolean) => void;
  readonly onCreateLabel: () => void;
  readonly onExport: () => void;
  readonly onDelete: () => void;
}) {
  const states = labelStates(labels, selected);
  return (
    <div className="contacts-toolbar">
      {leading}
      <button
        type="button"
        className="contacts-icon-button focus-ring"
        aria-label="Clear selection"
        title="Clear selection"
        onClick={onClear}
      >
        <ClearIcon aria-hidden="true" />
      </button>
      <span className="type-body font-medium" aria-live="polite">
        {selected.length.toLocaleString()} selected
      </span>
      <span className="flex-1" />
      <div className="contacts-toolbar-actions" role="toolbar" aria-label="Selected contacts">
        <Menu>
          <MenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <LabelIcon size={16} aria-hidden="true" />
              Manage labels
            </Button>
          </MenuTrigger>
          <MenuContent align="end" aria-label="Labels for the selected contacts">
            {labels.length === 0 ? <MenuLabel>No labels yet</MenuLabel> : null}
            {labels.map((label) => {
              const state = states.get(label.name) ?? false;
              return (
                <MenuCheckboxItem
                  key={label.name}
                  checked={state}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => onLabel(label.name, state !== true)}
                >
                  {label.name}
                </MenuCheckboxItem>
              );
            })}
            <MenuSeparator />
            <MenuItem icon={<PlusIcon />} onSelect={onCreateLabel}>
              Create label
            </MenuItem>
          </MenuContent>
        </Menu>
        <button type="button" className="btn" onClick={onExport}>
          <ExportIcon size={16} aria-hidden="true" />
          Export
        </button>
        <button type="button" className="btn" onClick={onDelete}>
          <TrashIcon size={16} aria-hidden="true" />
          Delete
        </button>
      </div>
    </div>
  );
}

export function ListActions({
  sort,
  onSortChange,
  onExport,
  canExport,
}: {
  readonly sort: ContactSortOrder;
  readonly onSortChange: (sort: ContactSortOrder) => void;
  readonly onExport: () => void;
  readonly canExport: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <Menu>
        <MenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="contacts-icon-button text-muted-foreground focus-ring"
            aria-label="Sort contacts"
            title="Sort"
          >
            <SortIcon aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" aria-label="Sort contacts">
          <MenuLabel>Sort by</MenuLabel>
          <MenuRadioGroup
            value={sort}
            onValueChange={(value) => onSortChange(value === "last" ? "last" : "first")}
          >
            <MenuRadioItem value="first">First name</MenuRadioItem>
            <MenuRadioItem value="last">Last name</MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <button
        type="button"
        className="contacts-icon-button focus-ring"
        aria-label="Export contacts"
        title="Export"
        disabled={!canExport}
        onClick={onExport}
      >
        <ExportIcon aria-hidden="true" />
      </button>
    </div>
  );
}
