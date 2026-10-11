/* `/contacts` search params: which list is on screen, an optional label
   filter, and the search text. Contacts is the default view. */
import { optionalEnumSearchParam, optionalStringSearchParam } from "@/lib/search-params";

const CONTACT_LIST_VIEWS = ["directory", "merge", "trash"] as const;
export type ContactListView = "contacts" | (typeof CONTACT_LIST_VIEWS)[number];

export interface ContactsRouteSearch {
  readonly view?: (typeof CONTACT_LIST_VIEWS)[number];
  readonly label?: string;
  readonly q?: string;
}

export function validateContactsRouteSearch(search: Record<string, unknown>): ContactsRouteSearch {
  const view = optionalEnumSearchParam(search.view, CONTACT_LIST_VIEWS);
  const label = optionalStringSearchParam(search.label);
  const q = optionalStringSearchParam(search.q);
  return {
    ...(view === undefined ? {} : { view }),
    ...(label === undefined || view !== undefined ? {} : { label }),
    ...(q === undefined ? {} : { q }),
  };
}
