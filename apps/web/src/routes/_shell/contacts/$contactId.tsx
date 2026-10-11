import { createFileRoute } from "@tanstack/react-router";
import { ContactDetail } from "@/features/contacts/contact-detail";
import { ContactForm } from "@/features/contacts/contact-form";
import { ContactsFrame } from "@/features/contacts/contacts-frame";
import { optionalBooleanSearchParam } from "@/lib/search-params";

interface ContactSearch {
  /** Show the edit form instead of the contact page. */
  readonly edit?: true;
}

export const Route = createFileRoute("/_shell/contacts/$contactId")({
  validateSearch: (search): ContactSearch =>
    optionalBooleanSearchParam(search.edit) ? { edit: true } : {},
  component: ContactRoute,
});

function ContactRoute() {
  const { contactId } = Route.useParams();
  const { edit } = Route.useSearch();
  return (
    <ContactsFrame location={{ kind: "view", view: "contacts" }}>
      {edit ? (
        <ContactForm key={`edit:${contactId}`} contactId={contactId} />
      ) : (
        <ContactDetail key={contactId} contactId={contactId} />
      )}
    </ContactsFrame>
  );
}
