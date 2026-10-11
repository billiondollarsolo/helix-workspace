/* Label palette and nesting helpers shared by the label dialog, the color
   menu and the Labels settings tab. Colors are the 24 `--label-<name>`
   tokens; the API stores the same names. */

import { MAIL_LABEL_COLOR_NAMES, type MailLabelColorName } from "@helix/contracts";
import type { MailLabelSummary } from "../api";

export const LABEL_COLORS: readonly MailLabelColorName[] = MAIL_LABEL_COLOR_NAMES;

/** Matches the API's limit; deeper parents are not offered. */
const MAX_LABEL_DEPTH = 5;
const MAX_LABEL_NAME_LENGTH = 225;

export function labelColorTitle(name: MailLabelColorName): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export function labelColorVar(name: MailLabelColorName): string {
  return `var(--label-${name})`;
}

interface LabelTreeEntry {
  readonly label: MailLabelSummary;
  /** 0 for a top-level label. */
  readonly depth: number;
  /** Full name with ancestors, e.g. `Clients/Acme`. */
  readonly path: string;
}

/** Depth-first order: each label follows its parent; siblings by sort order, then name. */
export function flattenLabelTree(labels: readonly MailLabelSummary[]): readonly LabelTreeEntry[] {
  const ids = new Set(labels.map((label) => label.id));
  const children = new Map<string | null, MailLabelSummary[]>();
  for (const label of labels) {
    const parent = label.parentId !== null && ids.has(label.parentId) ? label.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), label]);
  }
  const entries: LabelTreeEntry[] = [];
  const visit = (parentId: string | null, depth: number, prefix: string) => {
    const siblings = [...(children.get(parentId) ?? [])].sort(
      (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
    for (const label of siblings) {
      const path = prefix === "" ? label.name : `${prefix}/${label.name}`;
      entries.push({ label, depth, path });
      visit(label.id, depth + 1, path);
    }
  };
  visit(null, 0, "");
  return entries;
}

/** The label and everything nested under it. */
export function labelSubtreeIds(labels: readonly MailLabelSummary[], id: string): Set<string> {
  const subtree = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const label of labels) {
      if (label.parentId !== null && subtree.has(label.parentId) && !subtree.has(label.id)) {
        subtree.add(label.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * Labels a label may be nested under: your own labels, never the label
 * itself or one of its sublabels, and only where the result stays within
 * the nesting limit.
 */
export function parentLabelOptions(
  labels: readonly MailLabelSummary[],
  editingId: string | null,
): readonly LabelTreeEntry[] {
  const excluded = editingId === null ? new Set<string>() : labelSubtreeIds(labels, editingId);
  return flattenLabelTree(labels).filter(
    (entry) =>
      !entry.label.shared && !excluded.has(entry.label.id) && entry.depth < MAX_LABEL_DEPTH - 1,
  );
}

/** Returns an error message, or null when the name can be saved. */
export function labelNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a label name.";
  if (trimmed.length > MAX_LABEL_NAME_LENGTH) {
    return `Use at most ${String(MAX_LABEL_NAME_LENGTH)} characters.`;
  }
  if (/\p{Cc}/u.test(trimmed)) return "Label names can't contain control characters.";
  return null;
}
