import { type DriveScope } from "./queries";

/** Sidebar and breadcrumb names, in sentence case. */
export const SCOPE_TITLE: Record<DriveScope, string> = {
  home: "Home",
  my: "My Drive",
  shared: "Shared with me",
  recent: "Recent",
  starred: "Starred",
  recordings: "Recordings",
  trash: "Trash",
};
