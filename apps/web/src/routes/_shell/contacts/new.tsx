import { createFileRoute } from "@tanstack/react-router";
import { ContactForm } from "@/features/contacts/contact-form";
import { ContactsFrame } from "@/features/contacts/contacts-frame";
import { optionalStringSearchParam } from "@/lib/search-params";

interface NewContactSearch {
  /** Start the new contact with this label (Create contact from a label view). */
  readonly label?: string;
}

export const Route = createFileRoute("/_shell/contacts/new")({
  validateSearch: (search): NewContactSearch => {
    const label = optionalStringSearchParam(search.label);
    return label === undefined ? {} : { label };
  },
  component: NewContactRoute,
});

function NewContactRoute() {
  const { label } = Route.useSearch();
  return (
    <ContactsFrame location={{ kind: "view", view: "contacts" }}>
      <ContactForm {...(label === undefined ? {} : { defaultLabel: label })} />
    </ContactsFrame>
  );
}
