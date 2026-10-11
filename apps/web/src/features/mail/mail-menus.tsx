/* Menu contents shared by the toolbars (dropdown menus) and the row
   right-click menu (context menu): Label as, Move to and Snooze. Radix
   dropdown and context menu items are separate components, so each list is
   written once against a small set of parts. */

import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { CalendarClock, Inbox, OctagonAlert, Plus, Settings2, Trash2 } from "lucide-react";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { useShellOverlays } from "@/components/shell/overlay-context";
import type { MailFolderKey, MailLabelSummary } from "./api";
import { openLabelDialog } from "./settings";
import { labelTree } from "./mail-label-tree";
import type { SnoozePreset } from "./mail-snooze";
import { labelDotStyle } from "./mail-view-helpers";

/** A plain button that forwards every prop, for Radix `asChild` menu and popover triggers. */
export function TriggerButton(props: ComponentProps<"button">) {
  return <button type="button" {...props} />;
}

interface ItemProps {
  readonly icon?: ReactNode;
  readonly shortcut?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onSelect?: (event: Event) => void;
  readonly children: ReactNode;
}

interface CheckboxItemProps {
  readonly checked: boolean | "indeterminate";
  readonly onSelect?: (event: Event) => void;
  readonly children: ReactNode;
}

interface MenuParts {
  readonly Item: ComponentType<ItemProps>;
  readonly CheckboxItem: ComponentType<CheckboxItemProps>;
  readonly Label: ComponentType<{ readonly children: ReactNode }>;
  readonly Separator: ComponentType;
}

export const DROPDOWN_PARTS: MenuParts = {
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  Label: MenuLabel,
  Separator: MenuSeparator,
};

export const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
};

function LabelName({ label, depth }: { readonly label: MailLabelSummary; readonly depth: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 12 }}>
      <span aria-hidden="true" className="mail-label-dot" style={labelDotStyle(label)} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** "Label as": a checkbox per label, then Create new and Manage labels. */
export function LabelMenuItems({
  parts,
  labels,
  applied,
  onToggle,
}: {
  readonly parts: MenuParts;
  readonly labels: readonly MailLabelSummary[];
  /** Whether every, some or none of the targets carry the label. */
  readonly applied: (slug: string) => boolean | "indeterminate";
  readonly onToggle: (slug: string, add: boolean) => void;
}) {
  const { CheckboxItem, Item, Label, Separator } = parts;
  const overlays = useShellOverlays();
  return (
    <>
      <Label>Label as</Label>
      {labels.length === 0 ? <Item disabled>No labels yet</Item> : null}
      {labelTree(labels).map(({ label, depth }) => {
        const state = applied(label.slug);
        return (
          <CheckboxItem
            key={label.id}
            checked={state}
            onSelect={() => onToggle(label.slug, state !== true)}
          >
            <LabelName label={label} depth={depth} />
          </CheckboxItem>
        );
      })}
      <Separator />
      <Item icon={<Plus />} onSelect={() => openLabelDialog({ mode: "create" })}>
        Create new
      </Item>
      <Item icon={<Settings2 />} onSelect={() => overlays.openSettings("mail/labels")}>
        Manage labels
      </Item>
    </>
  );
}

export type MoveTarget =
  | { readonly kind: "inbox" }
  | { readonly kind: "spam" }
  | { readonly kind: "trash" }
  | { readonly kind: "label"; readonly slug: string };

/** "Move to": back to the Inbox, a label, Spam or Trash. */
export function MoveMenuItems({
  parts,
  folder,
  labels,
  onMove,
}: {
  readonly parts: MenuParts;
  readonly folder: MailFolderKey;
  readonly labels: readonly MailLabelSummary[];
  readonly onMove: (target: MoveTarget) => void;
}) {
  const { Item, Label, Separator } = parts;
  return (
    <>
      <Label>Move to</Label>
      {folder === "inbox" ? null : (
        <Item icon={<Inbox />} onSelect={() => onMove({ kind: "inbox" })}>
          Inbox
        </Item>
      )}
      {labelTree(labels).map(({ label, depth }) => (
        <Item key={label.id} onSelect={() => onMove({ kind: "label", slug: label.slug })}>
          <LabelName label={label} depth={depth} />
        </Item>
      ))}
      <Separator />
      {folder === "spam" ? null : (
        <Item icon={<OctagonAlert />} onSelect={() => onMove({ kind: "spam" })}>
          Spam
        </Item>
      )}
      {folder === "trash" ? null : (
        <Item icon={<Trash2 />} onSelect={() => onMove({ kind: "trash" })}>
          Trash
        </Item>
      )}
    </>
  );
}

/** Snooze presets as menu items, plus "Pick date & time". */
export function SnoozeMenuItems({
  parts,
  presets,
  onSnooze,
  onPickDate,
}: {
  readonly parts: MenuParts;
  readonly presets: readonly SnoozePreset[];
  readonly onSnooze: (until: string) => void;
  readonly onPickDate: () => void;
}) {
  const { Item, Label, Separator } = parts;
  return (
    <>
      <Label>Snooze until…</Label>
      {presets.map((preset) => (
        <Item
          key={preset.id}
          shortcut={preset.detail}
          onSelect={() => onSnooze(preset.until.toISOString())}
        >
          {preset.label}
        </Item>
      ))}
      <Separator />
      <Item icon={<CalendarClock />} onSelect={onPickDate}>
        Pick date &amp; time
      </Item>
    </>
  );
}
