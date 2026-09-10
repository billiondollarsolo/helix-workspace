import { type DriveScope } from "./queries";

export const SCOPE_TITLE: Record<DriveScope, string> = {
  my: "My Drive",
  shared: "Shared with me",
  recent: "Recent",
  starred: "Starred",
  recordings: "Recordings",
  trash: "Trash",
};

/** A folder in the breadcrumb trail. `null` id is the scope root. */
export interface DriveCrumb {
  readonly id: string | null;
  readonly name: string;
}
