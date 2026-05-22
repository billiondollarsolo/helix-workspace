/* Docs seed data — ported from the design handoff (app-docs.jsx → DOC_LIST etc.).
   Typed, immutable. The list view falls back to this when the Docs backend
   is unavailable; backend documents are merged in over the top. */

import type { IconComponent } from "@/components/icons";
import { Icons } from "@/components/icons";

export type DocFolderId =
  | "all"
  | "recent"
  | "mine"
  | "shared"
  | "starred"
  | "trash";

export interface DocSummary {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly modified: string;
  /** Number of people the doc is shared with. */
  readonly shared: number;
  /** Tag-folder id — matches a `DocTagFolder.id`. */
  readonly folder: string;
  readonly starred: boolean;
  /** True when the signed-in user owns the document. */
  readonly mine: boolean;
  /** "backend" rows come from the Docs API; "local" rows are seed data. */
  readonly source: "backend" | "local";
}

export interface DocFolder {
  readonly id: DocFolderId;
  readonly label: string;
  readonly icon: IconComponent;
}

export interface DocTagFolder {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

export interface SlashItem {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  readonly icon: IconComponent;
}

/** The signed-in user, for owner/`mine` resolution in seed data. */
export const CURRENT_USER = "Alex Park";

export const DOC_LIST: readonly DocSummary[] = [
  doc("d1", "Q3 Roadmap — final draft", "Mira Okafor", "10 minutes ago", 4, "Product", { starred: true }),
  doc("d2", "Helix design principles", "Priya Anand", "2 hours ago", 12, "Design"),
  doc("d3", "Postmortem — Auth incident 05/15", "Daniel Cho", "Yesterday", 6, "Engineering"),
  doc("d4", "All-hands narrative — May", CURRENT_USER, "Yesterday", 2, "Product", { mine: true }),
  doc("d5", "Atlas renewal — strategy memo", "Rumi Tanaka", "Monday", 5, "Sales", { starred: true }),
  doc("d6", "Brand voice and tone guide", "Owen Hart", "Last week", 18, "Marketing"),
  doc("d7", "API v2 design RFC", "Jonas Reichert", "Last week", 9, "Engineering"),
  doc("d8", "EMEA hiring plan FY26", "Sasha Levin", "Last week", 4, "People"),
  doc("d9", "Product strategy 2027 — early draft", CURRENT_USER, "2 days ago", 1, "Product", {
    mine: true,
    starred: true,
  }),
  doc("d10", "1:1 notes — Jonas", CURRENT_USER, "3 days ago", 1, "People", { mine: true }),
  doc("d11", "Quarterly review — Q2 retro", CURRENT_USER, "Last week", 8, "Product", { mine: true }),
  doc("d12", "Helix AI launch plan", "Owen Hart", "2 weeks ago", 14, "Marketing", { starred: true }),
];

export const DOC_FOLDERS: readonly DocFolder[] = [
  { id: "all", label: "All documents", icon: Icons.Doc },
  { id: "recent", label: "Recent", icon: Icons.History },
  { id: "mine", label: "Owned by me", icon: Icons.Users },
  { id: "shared", label: "Shared with me", icon: Icons.Users },
  { id: "starred", label: "Starred", icon: Icons.Star },
  { id: "trash", label: "Trash", icon: Icons.Trash },
];

export const DOC_TAG_FOLDERS: readonly DocTagFolder[] = [
  { id: "Product", label: "Product", color: "#7c3aed" },
  { id: "Engineering", label: "Engineering", color: "#0891b2" },
  { id: "Design", label: "Design", color: "#db2777" },
  { id: "Sales", label: "Sales", color: "#059669" },
  { id: "Marketing", label: "Marketing", color: "#ea580c" },
  { id: "People", label: "People", color: "#475569" },
];

export const DOC_TEMPLATES: readonly string[] = [
  "Meeting notes",
  "PRD",
  "RFC",
  "Brainstorm",
  "1:1 doc",
];

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "h1", title: "Heading 1", sub: "Large section title", icon: Icons.H1 },
  { id: "h2", title: "Heading 2", sub: "Subsection title", icon: Icons.H2 },
  { id: "ul", title: "Bulleted list", sub: "Simple bullet list", icon: Icons.List },
  { id: "ol", title: "Numbered list", sub: "Numbered list", icon: Icons.ListNum },
  { id: "quote", title: "Quote", sub: "Block quote", icon: Icons.Quote },
  { id: "code", title: "Code block", sub: "Monospaced code", icon: Icons.Code },
  { id: "hr", title: "Divider", sub: "Horizontal line", icon: Icons.Divider },
  { id: "img", title: "Image", sub: "Insert image", icon: Icons.Image },
  { id: "ai", title: "Helix AI", sub: "Draft, summarize, improve", icon: Icons.Sparkles },
];

export interface OutlineEntry {
  /** Heading level, 1–3. */
  readonly level: 1 | 2 | 3;
  readonly text: string;
}

export const DOC_OUTLINE: readonly OutlineEntry[] = [
  { level: 1, text: "Q3 Roadmap" },
  { level: 2, text: "Context" },
  { level: 2, text: "Open decisions" },
  { level: 3, text: "Atlas migration timing" },
  { level: 3, text: "Platform hiring" },
  { level: 3, text: "Pricing tier" },
  { level: 2, text: "Risks & dependencies" },
  { level: 2, text: "Timeline" },
  { level: 2, text: "Appendix" },
];

export interface DocComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly time: string;
  readonly replies: number;
}

export const DOC_COMMENTS: readonly DocComment[] = [
  {
    id: "c1",
    author: "Priya Anand",
    body: "Should we explicitly list the customers in this section, or leave it for the linked sheet?",
    time: "8m ago",
    replies: 1,
  },
  {
    id: "c2",
    author: "Jonas Reichert",
    body: "+1 — also want to flag that the SRE role may need to be re-leveled.",
    time: "12m ago",
    replies: 0,
  },
  {
    id: "c3",
    author: "Daniel Cho",
    body: "Suggesting we add an explicit dependency callout on the auth migration. I'll add it in a comment thread below.",
    time: "1h ago",
    replies: 2,
  },
];

export interface DocVersion {
  readonly id: string;
  readonly who: string;
  readonly when: string;
  readonly note?: string;
}

export const DOC_VERSIONS: readonly DocVersion[] = [
  { id: "v1", who: "Mira Okafor", when: "10 min ago", note: "Current version" },
  { id: "v2", who: "Jonas Reichert", when: "1 hour ago" },
  { id: "v3", who: "Mira Okafor", when: "3 hours ago", note: "Reorganized open decisions" },
  { id: "v4", who: "Priya Anand", when: "Yesterday" },
  { id: "v5", who: "Mira Okafor", when: "Yesterday", note: "First draft" },
  { id: "v6", who: "Mira Okafor", when: "2 days ago" },
];

export interface DocAiSuggestion {
  readonly id: string;
  readonly icon: IconComponent;
  readonly title: string;
  readonly sub: string;
}

export const DOC_AI_SUGGESTIONS: readonly DocAiSuggestion[] = [
  {
    id: "ai-summary",
    icon: Icons.Sparkles,
    title: "Draft executive summary",
    sub: "1-paragraph TL;DR at the top",
  },
  {
    id: "ai-actions",
    icon: Icons.List,
    title: "Pull out action items",
    sub: "Extract owners and dates",
  },
  {
    id: "ai-improve",
    icon: Icons.EditPen,
    title: "Improve writing",
    sub: "Tighten and clarify the open decisions",
  },
  {
    id: "ai-comments",
    icon: Icons.Comment,
    title: "Resolve open comments",
    sub: "Draft replies to the 3 open threads",
  },
];

export type ShareRole = "Owner" | "Editor" | "Commenter" | "Viewer";

export interface SharePerson {
  readonly name: string;
  readonly email: string;
  readonly role: ShareRole;
  readonly you: boolean;
}

export const SHARE_PEOPLE: readonly SharePerson[] = [
  { name: CURRENT_USER, email: "alex.park@helix.io", role: "Owner", you: true },
  { name: "Mira Okafor", email: "mira.okafor@helix.io", role: "Editor", you: false },
  { name: "Jonas Reichert", email: "jonas.reichert@helix.io", role: "Editor", you: false },
  { name: "Priya Anand", email: "priya.anand@helix.io", role: "Commenter", you: false },
  { name: "Daniel Cho", email: "daniel.cho@helix.io", role: "Viewer", you: false },
];

export type GeneralAccess = "restricted" | "helix" | "helix-edit" | "public";

export const GENERAL_ACCESS_OPTIONS: ReadonlyArray<{
  readonly id: GeneralAccess;
  readonly label: string;
  readonly hint: string;
}> = [
  { id: "restricted", label: "Restricted", hint: "Only people with access can open" },
  { id: "helix", label: "Anyone at Helix can view", hint: "Anyone at helix.io can view" },
  { id: "helix-edit", label: "Anyone at Helix can edit", hint: "Anyone at helix.io can edit" },
  { id: "public", label: "Anyone with link", hint: "Anyone with the link on the internet" },
];

export interface LiveCursor {
  readonly name: string;
  readonly color: string;
}

/** Live collaborators rendered as blinking cursors in the editor body. */
export const LIVE_CURSORS: readonly LiveCursor[] = [
  { name: "Jonas", color: "#0891b2" },
];

/** Collaborators in the editor toolbar avatar stack. */
export const EDITOR_COLLABORATORS: readonly string[] = [
  "Mira Okafor",
  "Jonas Reichert",
  "Priya Anand",
];

function doc(
  id: string,
  title: string,
  owner: string,
  modified: string,
  shared: number,
  folder: string,
  flags: { readonly starred?: boolean; readonly mine?: boolean } = {},
): DocSummary {
  return {
    id,
    title,
    owner,
    modified,
    shared,
    folder,
    starred: flags.starred ?? false,
    mine: flags.mine ?? false,
    source: "local",
  };
}

/** Human-friendly relative timestamp for a Docs list row. */
export function formatModified(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Recently";
  }
  const ageMs = Date.now() - timestamp;
  if (ageMs >= 0 && ageMs < 60_000) {
    return "Just now";
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}

/** Folder-specific empty-state copy for the list view. */
export const FOLDER_EMPTY_STATES: Readonly<
  Record<DocFolderId, { readonly icon: IconComponent; readonly title: string; readonly body: string }>
> = {
  all: { icon: Icons.Doc, title: "No documents", body: "Create a doc to get started." },
  recent: { icon: Icons.History, title: "Nothing recent", body: "Documents you open will appear here." },
  trash: { icon: Icons.Trash, title: "Trash is empty", body: "Deleted documents appear here for 30 days." },
  mine: { icon: Icons.Doc, title: "You don't own any docs", body: "Documents you create will appear here." },
  starred: { icon: Icons.Star, title: "No starred documents", body: "Star a doc to find it here later." },
  shared: {
    icon: Icons.Users,
    title: "Nothing shared with you yet",
    body: "Docs others share with you appear here.",
  },
};
