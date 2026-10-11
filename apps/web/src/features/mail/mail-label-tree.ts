import type { MailLabelSummary } from "./api";

export interface LabelTreeEntry {
  readonly label: MailLabelSummary;
  readonly depth: number;
  readonly hasChildren: boolean;
}

function byOrder(a: MailLabelSummary, b: MailLabelSummary): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

/** Labels in display order with their nesting depth; orphans sit at the top level. */
export function labelTree(labels: readonly MailLabelSummary[]): LabelTreeEntry[] {
  const ids = new Set(labels.map((label) => label.id));
  const children = new Map<string | null, MailLabelSummary[]>();
  for (const label of labels) {
    const parent = label.parentId !== null && ids.has(label.parentId) ? label.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), label]);
  }
  const ordered: LabelTreeEntry[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const label of [...(children.get(parent) ?? [])].sort(byOrder)) {
      ordered.push({ label, depth, hasChildren: children.has(label.id) });
      visit(label.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}
