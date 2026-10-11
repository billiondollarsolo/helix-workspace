/* Where the Contacts navigation is, from the /contacts search params. Kept
   apart from route-search.ts so only the validator is in the initial bundle. */
import type { ContactListView, ContactsRouteSearch } from "./route-search";

/** Where the sidebar is: a list view, or a label within Contacts. */
export type ContactsLocation =
  | { readonly kind: "view"; readonly view: ContactListView }
  | { readonly kind: "label"; readonly label: string };

export function contactsLocation(search: ContactsRouteSearch): ContactsLocation {
  if (search.label !== undefined) return { kind: "label", label: search.label };
  return { kind: "view", view: search.view ?? "contacts" };
}
