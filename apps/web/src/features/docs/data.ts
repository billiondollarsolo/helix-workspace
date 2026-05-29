/* Docs — shared types + static UI taxonomy.
 *
 * The seed `DOC_LIST` / `DOC_TAG_FOLDERS` / `DOC_COMMENTS` / `DOC_VERSIONS`
 * / `DOC_AI_SUGGESTIONS` / `SHARE_PEOPLE` / `LIVE_CURSORS` /
 * `EDITOR_COLLABORATORS` arrays that lived here have been removed. Document
 * rows, comments, versions, AI suggestions, and share lists now come
 * exclusively from the live Docs tools; the editor surfaces loading / empty
 * states where the backend hasn't yet shipped support for a panel. What
 * remains here are the shared view-model types, static folder + slash-menu
 * + general-access taxonomies, a relative-time formatter, and the
 * folder-specific empty-state copy. */

import type { IconComponent } from "@/components/icons";
import { Icons } from "@/components/icons";
import type { DriveApiPreview } from "@/features/drive/api";

export type DocFolderId = "all" | "recent" | "mine" | "shared" | "starred" | "trash";

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
  /** Non-null when the Drive object is in trash. */
  readonly deletedAt: string | null;
  /** "backend" rows come from the Docs API; "local" rows are local-only. */
  readonly source: "backend" | "local";
  readonly mimeType?: string | undefined;
  /** Short uppercase chip label for the source format (e.g. "MD", "DOCX",
   *  "PDF") so the user can tell at a glance how the doc was originally
   *  imported. */
  readonly formatLabel: string;
  readonly preview?: DriveApiPreview | undefined;
  readonly editorEngine?: string | undefined;
  readonly formatVersion?: number | undefined;
  readonly openMode?: "native" | "office" | undefined;
}

export interface DocFolder {
  readonly id: DocFolderId;
  readonly label: string;
  readonly icon: IconComponent;
}

export interface SlashItem {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  readonly icon: IconComponent;
}

export const DOC_FOLDERS: readonly DocFolder[] = [
  { id: "all", label: "All documents", icon: Icons.Doc },
  { id: "recent", label: "Recent", icon: Icons.History },
  { id: "mine", label: "Owned by me", icon: Icons.Users },
  { id: "shared", label: "Shared with me", icon: Icons.Users },
  { id: "starred", label: "Starred", icon: Icons.Star },
  { id: "trash", label: "Trash", icon: Icons.Trash },
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

export type ShareRole = "Owner" | "Editor" | "Commenter" | "Viewer";

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
  Record<
    DocFolderId,
    { readonly icon: IconComponent; readonly title: string; readonly body: string }
  >
> = {
  all: { icon: Icons.Doc, title: "No documents", body: "Create a doc to get started." },
  recent: {
    icon: Icons.History,
    title: "Nothing recent",
    body: "Documents you open will appear here.",
  },
  trash: {
    icon: Icons.Trash,
    title: "Trash is empty",
    body: "Deleted documents appear here for 30 days.",
  },
  mine: {
    icon: Icons.Doc,
    title: "You don't own any docs",
    body: "Documents you create will appear here.",
  },
  starred: {
    icon: Icons.Star,
    title: "No starred documents",
    body: "Star a doc to find it here later.",
  },
  shared: {
    icon: Icons.Users,
    title: "Nothing shared with you yet",
    body: "Docs others share with you appear here.",
  },
};
