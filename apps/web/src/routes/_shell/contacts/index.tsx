import { createFileRoute } from "@tanstack/react-router";
import { ContactList } from "@/features/contacts/contact-list";
import { ContactsFrame } from "@/features/contacts/contacts-frame";
import { DirectoryView, MergeView, TrashView } from "@/features/contacts/contacts-views";
import { contactsLocation, type ContactsLocation } from "@/features/contacts/route-location";
import {
  validateContactsRouteSearch,
  type ContactsRouteSearch,
} from "@/features/contacts/route-search";

export const Route = createFileRoute("/_shell/contacts/")({
  validateSearch: (search): ContactsRouteSearch => validateContactsRouteSearch(search),
  component: ContactsRoute,
});

function ContactsPage({
  location,
  query,
}: {
  readonly location: ContactsLocation;
  readonly query: string;
}) {
  if (location.kind === "label") {
    return <ContactList key={`label:${location.label}`} label={location.label} query={query} />;
  }
  switch (location.view) {
    case "directory":
      return <DirectoryView query={query} />;
    case "trash":
      return <TrashView query={query} />;
    case "merge":
      return <MergeView />;
    default:
      return <ContactList query={query} />;
  }
}

function ContactsRoute() {
  const search = Route.useSearch();
  const location = contactsLocation(search);
  const query = search.q ?? "";
  return (
    <ContactsFrame location={location} query={query}>
      <ContactsPage location={location} query={query} />
    </ContactsFrame>
  );
}
