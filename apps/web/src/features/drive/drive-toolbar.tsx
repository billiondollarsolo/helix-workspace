/* The row under the breadcrumb: filter chips with sort, layout and details
   toggles, or — once something is selected — the selection toolbar. */
import {
  ArrowDown as DescIcon,
  ArrowUp as AscIcon,
  ChevronDown as ChipMenuIcon,
  EllipsisVertical as MoreIcon,
  Grid2X2 as GridIcon,
  Info as InfoIcon,
  List as ListIcon,
  X as ClearIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import type { DriveItem } from "./drive-data";
import {
  DriveMenuItems,
  driveActionIcon,
  type DriveAction,
  type DriveActionId,
} from "./drive-item-actions";
import {
  DRIVE_SORT_OPTIONS,
  DRIVE_TYPE_FILTER_OPTIONS,
  driveModifiedOptions,
  drivePeopleFilterLabel,
  drivePeopleOptions,
  driveSortLabel,
  hasDriveFilters,
  NO_DRIVE_FILTERS,
  type DriveFilters,
  type DriveSort,
} from "./drive-sort-filter";
import { DriveTypeIcon } from "./drive-type-icon";
import type { DocumentSurfaceView } from "./view-preference";
import { DriveMenuButton } from "./drive-menu-button";

/** Toolbar buttons shown directly; everything else stays in ⋮. */
const PRIMARY_SELECTION_ACTIONS: readonly DriveActionId[] = [
  "share",
  "download",
  "move",
  "star",
  "unstar",
  "trash",
  "restore",
  "delete-forever",
];

function FilterChip({
  label,
  activeLabel,
  onClear,
  children,
}: {
  readonly label: string;
  readonly activeLabel: string | null;
  readonly onClear: () => void;
  readonly children: ReactNode;
}) {
  const active = activeLabel !== null;
  return (
    <div className="drive-chip" data-active={active || undefined}>
      <Menu>
        <MenuTrigger asChild>
          <DriveMenuButton
            className="drive-chip-trigger"
            aria-label={active ? `${label}: ${activeLabel}` : label}
          >
            <span className="truncate">{activeLabel ?? label}</span>
            {active ? null : <ChipMenuIcon size={16} aria-hidden="true" />}
          </DriveMenuButton>
        </MenuTrigger>
        <MenuContent className="min-w-56">{children}</MenuContent>
      </Menu>
      {active ? (
        <button
          type="button"
          className="drive-chip-clear"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          onClick={onClear}
        >
          <ClearIcon size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function SortMenu({
  sort,
  onSortChange,
}: {
  readonly sort: DriveSort;
  readonly onSortChange: (sort: DriveSort) => void;
}) {
  const DirectionIcon = sort.direction === "asc" ? AscIcon : DescIcon;
  const textual = sort.key === "name";
  return (
    <Menu>
      <MenuTrigger asChild>
        <DriveMenuButton
          className="btn sm ghost"
          aria-label={`Sort by ${driveSortLabel(sort.key)}, ${sort.direction === "asc" ? "ascending" : "descending"}`}
        >
          <span className="drive-sort-label">{driveSortLabel(sort.key)}</span>
          <DirectionIcon size={16} aria-hidden="true" />
        </DriveMenuButton>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-56">
        <MenuLabel>Sort by</MenuLabel>
        <MenuRadioGroup
          value={sort.key}
          onValueChange={(value) => {
            const option = DRIVE_SORT_OPTIONS.find((candidate) => candidate.key === value);
            if (option !== undefined) {
              onSortChange({ key: option.key, direction: option.defaultDirection });
            }
          }}
        >
          {DRIVE_SORT_OPTIONS.map((option) => (
            <MenuRadioItem key={option.key} value={option.key}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Sort direction</MenuLabel>
        <MenuRadioGroup
          value={sort.direction}
          onValueChange={(value) =>
            onSortChange({ key: sort.key, direction: value === "desc" ? "desc" : "asc" })
          }
        >
          <MenuRadioItem value="asc">
            {textual ? "A to Z" : "Oldest or smallest first"}
          </MenuRadioItem>
          <MenuRadioItem value="desc">
            {textual ? "Z to A" : "Newest or largest first"}
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export function DriveFilterBar({
  items,
  actorId,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  sortable,
  view,
  onViewChange,
  detailsOpen,
  onToggleDetails,
}: {
  readonly items: readonly DriveItem[];
  readonly actorId: string | null;
  readonly filters: DriveFilters;
  readonly onFiltersChange: (filters: DriveFilters) => void;
  readonly sort: DriveSort;
  readonly onSortChange: (sort: DriveSort) => void;
  /** Home, Recent and search keep their own relevance order. */
  readonly sortable: boolean;
  readonly view: DocumentSurfaceView;
  readonly onViewChange: (view: DocumentSurfaceView) => void;
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
}) {
  const typeLabel =
    DRIVE_TYPE_FILTER_OPTIONS.find((option) => option.value === filters.type)?.label ?? null;
  const modifiedOptions = driveModifiedOptions();
  const modifiedLabel =
    modifiedOptions.find((option) => option.value === filters.modified)?.label ?? null;
  const people = drivePeopleOptions(items, actorId);
  return (
    <div className="drive-toolbar" role="toolbar" aria-label="Filters and layout">
      <div className="drive-chips">
        <FilterChip
          label="Type"
          activeLabel={typeLabel}
          onClear={() => onFiltersChange({ ...filters, type: null })}
        >
          {DRIVE_TYPE_FILTER_OPTIONS.map((option) => (
            <MenuItem
              key={option.value}
              icon={<DriveTypeIcon type={option.value} size={18} />}
              onSelect={() => onFiltersChange({ ...filters, type: option.value })}
            >
              {option.label}
            </MenuItem>
          ))}
        </FilterChip>
        <FilterChip
          label="People"
          activeLabel={filters.people === null ? null : drivePeopleFilterLabel(filters.people)}
          onClear={() => onFiltersChange({ ...filters, people: null })}
        >
          <MenuItem onSelect={() => onFiltersChange({ ...filters, people: { kind: "me" } })}>
            Owned by me
          </MenuItem>
          <MenuItem onSelect={() => onFiltersChange({ ...filters, people: { kind: "not-me" } })}>
            Not owned by me
          </MenuItem>
          {people.length > 0 ? <MenuSeparator /> : null}
          {people.map((person) => (
            <MenuItem
              key={person.actorId}
              onSelect={() =>
                onFiltersChange({
                  ...filters,
                  people: { kind: "owner", actorId: person.actorId, label: person.label },
                })
              }
            >
              {person.label}
            </MenuItem>
          ))}
        </FilterChip>
        <FilterChip
          label="Modified"
          activeLabel={modifiedLabel}
          onClear={() => onFiltersChange({ ...filters, modified: null })}
        >
          {modifiedOptions.map((option) => (
            <MenuItem
              key={option.value}
              onSelect={() => onFiltersChange({ ...filters, modified: option.value })}
            >
              {option.label}
            </MenuItem>
          ))}
        </FilterChip>
        {hasDriveFilters(filters) ? (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => onFiltersChange(NO_DRIVE_FILTERS)}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="drive-toolbar-end">
        {sortable ? <SortMenu sort={sort} onSortChange={onSortChange} /> : null}
        <div className="drive-layout-toggle" role="group" aria-label="Layout">
          <button
            type="button"
            aria-label="List layout"
            aria-pressed={view === "list"}
            onClick={() => onViewChange("list")}
          >
            <ListIcon size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Grid layout"
            aria-pressed={view === "grid"}
            onClick={() => onViewChange("grid")}
          >
            <GridIcon size={18} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="View details"
          aria-pressed={detailsOpen}
          onClick={onToggleDetails}
        >
          <InfoIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** "2 selected ✕ | Share Download Move Star Trash ⋮" */
export function DriveSelectionBar({
  count,
  actions,
  onAction,
  onClear,
}: {
  readonly count: number;
  readonly actions: readonly DriveAction[];
  readonly onAction: (id: DriveActionId) => void;
  readonly onClear: () => void;
}) {
  const primary = actions.filter((action) => PRIMARY_SELECTION_ACTIONS.includes(action.id));
  return (
    <div className="drive-toolbar drive-selection-bar" role="toolbar" aria-label="Selection">
      <button type="button" className="icon-btn" aria-label="Clear selection" onClick={onClear}>
        <ClearIcon size={18} aria-hidden="true" />
      </button>
      <span className="type-body-sm font-semibold" aria-live="polite">
        {count} selected
      </span>
      <span className="drive-toolbar-divider" aria-hidden="true" />
      {primary.map((action) => {
        const Icon = driveActionIcon(action.id);
        return (
          <button
            key={action.id}
            type="button"
            className="icon-btn"
            aria-label={action.label}
            title={action.label}
            disabled={action.disabled}
            onClick={() => onAction(action.id)}
          >
            <Icon size={18} aria-hidden="true" />
          </button>
        );
      })}
      <Menu>
        <MenuTrigger asChild>
          <DriveMenuButton className="icon-btn" aria-label="More actions">
            <MoreIcon size={18} aria-hidden="true" />
          </DriveMenuButton>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-60">
          <DriveMenuItems actions={actions} onAction={onAction} />
        </MenuContent>
      </Menu>
    </div>
  );
}
