/* Create or edit a contact: picture, name, company and title, repeatable
   email, phone and address rows, birthday, notes and labels. Edits send
   only the fields that changed. */
import type { Contact } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Building2 as CompanyIcon,
  ImagePlus as PhotoIcon,
  StickyNote as NotesIcon,
  User as NameIcon,
  X as CloseIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { PersonAvatar } from "@/components/people/person-chip";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes-warning";
import {
  contactLabelsQueryOptions,
  contactQueryOptions,
  contactsQueryKeys,
  createContact,
  updateContact,
} from "./api";
import {
  AddressFields,
  BirthdayField,
  EmailFields,
  LabelsField,
  PhoneFields,
} from "./contact-form-fields";
import {
  contactDisplayNamePreview,
  draftErrors,
  draftFromContact,
  fieldsFromDraft,
  hasDraftErrors,
  patchFromDraft,
  type ContactDraft,
} from "./model";
import { contactPictureDataUrl } from "./photo";

export function ContactForm({
  contactId,
  defaultLabel,
}: {
  readonly contactId?: string;
  readonly defaultLabel?: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...contactQueryOptions(contactId ?? ""),
    enabled: contactId !== undefined,
  });
  if (contactId === undefined) {
    return <ContactFormBody original={null} defaultLabel={defaultLabel} />;
  }
  if (query.data === undefined) {
    return (
      <section className="contacts-main" aria-label="Edit contact">
        <div className="contacts-scroll">
          {query.error === null ? (
            <Skeleton variant="card" count={1} label="Loading contact" />
          ) : (
            <InlineError
              title="Couldn’t load this contact"
              message={query.error.message}
              onRetry={() =>
                void queryClient.invalidateQueries({ queryKey: contactsQueryKeys.all })
              }
              retrying={query.isFetching}
            />
          )}
        </div>
      </section>
    );
  }
  return <ContactFormBody key={query.data.id} original={query.data} defaultLabel={undefined} />;
}

function ContactFormBody({
  original,
  defaultLabel,
}: {
  readonly original: Contact | null;
  readonly defaultLabel: string | undefined;
}) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const labels = useQuery(contactLabelsQueryOptions());
  const initial = useMemo(
    () => draftFromContact(original, defaultLabel === undefined ? {} : { labels: [defaultLabel] }),
    [original, defaultLabel],
  );
  const [draft, setDraft] = useState<ContactDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const errors = draftErrors(draft);
  const dirty = JSON.stringify(fieldsFromDraft(draft)) !== JSON.stringify(fieldsFromDraft(initial));
  const unsaved = useUnsavedChangesWarning(dirty && savedId === null && !saving, "this contact", {
    message: "Your changes to this contact will be discarded.",
    stayLabel: "Keep editing",
    leaveLabel: "Discard",
  });
  const update = <K extends keyof ContactDraft>(key: K, value: ContactDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (savedId === null) return;
    void navigate({
      to: "/contacts/$contactId",
      params: { contactId: savedId },
      search: {},
      replace: true,
    });
  }, [savedId, navigate, original]);

  const close = () => {
    if (original === null) void navigate({ to: "/contacts" });
    else
      void navigate({ to: "/contacts/$contactId", params: { contactId: original.id }, search: {} });
  };

  const save = async () => {
    setShowErrors(true);
    if (hasDraftErrors(errors)) return;
    setSaving(true);
    setSaveError(null);
    try {
      let saved: Contact;
      if (original === null) {
        saved = await createContact(fieldsFromDraft(draft));
      } else {
        const patch = patchFromDraft(original, draft);
        saved =
          Object.keys(patch).length === 0 ? original : await updateContact(original.id, patch);
      }
      queryClient.setQueryData(contactsQueryKeys.detail(saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: contactsQueryKeys.all });
      notify({ message: original === null ? "Contact created" : "Contact saved" });
      setSavedId(saved.id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const choosePicture = async (file: File | undefined) => {
    setPhotoError(null);
    if (file === undefined) return;
    try {
      update("photoDataUrl", await contactPictureDataUrl(file));
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "The picture could not be used.");
    }
  };

  const title = original === null ? "Create contact" : "Edit contact";
  const shown = showErrors ? errors : { entries: {} };
  return (
    <section className="contacts-main contacts-form-page" aria-labelledby={`${id}-title`}>
      <form
        className="contacts-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="contacts-detail-bar">
          <button
            type="button"
            className="contacts-icon-button focus-ring"
            aria-label="Close"
            title="Close"
            onClick={close}
          >
            <CloseIcon aria-hidden="true" />
          </button>
          <h1 id={`${id}-title`} className="type-h3 m-0">
            {title}
          </h1>
          <span className="flex-1" />
          <button
            type="submit"
            className="btn primary"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            Save
          </button>
        </div>
        <div className="contacts-scroll">
          <div className="contacts-form-body">
            <div className="contacts-photo">
              {draft.photoDataUrl === null && contactDisplayNamePreview(draft) === null ? (
                <span className="contacts-photo-placeholder" aria-hidden="true">
                  <NameIcon />
                </span>
              ) : (
                <PersonAvatar
                  person={{
                    displayName: contactDisplayNamePreview(draft) ?? "",
                    avatarDataUrl: draft.photoDataUrl,
                  }}
                  size={96}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className="btn contacts-photo-button">
                  <PhotoIcon size={16} aria-hidden="true" />
                  {draft.photoDataUrl === null ? "Add picture" : "Change picture"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="sr-only"
                    onChange={(event) => void choosePicture(event.target.files?.[0])}
                  />
                </label>
                {draft.photoDataUrl === null ? null : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => update("photoDataUrl", null)}
                  >
                    Remove picture
                  </button>
                )}
              </div>
              {photoError === null ? null : (
                <p className="m-0 type-caption text-destructive">{photoError}</p>
              )}
            </div>
            <fieldset className="contacts-field-group">
              <legend className="contacts-field-legend">
                <span aria-hidden="true">
                  <NameIcon size={18} />
                </span>
                Name
              </legend>
              <div className="contacts-two-up">
                <input
                  className="input"
                  aria-label="First name"
                  placeholder="First name"
                  autoComplete="off"
                  value={draft.givenName}
                  onChange={(event) => update("givenName", event.target.value)}
                />
                <input
                  className="input"
                  aria-label="Last name"
                  placeholder="Last name"
                  autoComplete="off"
                  value={draft.familyName}
                  onChange={(event) => update("familyName", event.target.value)}
                />
              </div>
            </fieldset>
            <fieldset className="contacts-field-group">
              <legend className="contacts-field-legend">
                <span aria-hidden="true">
                  <CompanyIcon size={18} />
                </span>
                Work
              </legend>
              <div className="contacts-two-up">
                <input
                  className="input"
                  aria-label="Company"
                  placeholder="Company"
                  autoComplete="off"
                  value={draft.company}
                  onChange={(event) => update("company", event.target.value)}
                />
                <input
                  className="input"
                  aria-label="Job title"
                  placeholder="Job title"
                  autoComplete="off"
                  value={draft.jobTitle}
                  onChange={(event) => update("jobTitle", event.target.value)}
                />
              </div>
            </fieldset>
            <EmailFields
              entries={draft.emails}
              errors={shown.entries}
              onChange={(emails) => update("emails", emails)}
            />
            <PhoneFields
              entries={draft.phones}
              errors={shown.entries}
              onChange={(phones) => update("phones", phones)}
            />
            <AddressFields
              entries={draft.addresses}
              errors={shown.entries}
              onChange={(addresses) => update("addresses", addresses)}
            />
            <BirthdayField
              value={draft.birthday}
              onChange={(birthday) => update("birthday", birthday)}
            />
            <fieldset className="contacts-field-group">
              <legend className="contacts-field-legend">
                <span aria-hidden="true">
                  <NotesIcon size={18} />
                </span>
                Notes
              </legend>
              <textarea
                className="input contacts-notes"
                aria-label="Notes"
                rows={4}
                maxLength={10_000}
                value={draft.notes}
                onChange={(event) => update("notes", event.target.value)}
              />
            </fieldset>
            <LabelsField
              value={draft.labels}
              labels={labels.data?.labels ?? []}
              onChange={(next) => update("labels", next)}
            />
            {showErrors && errors.form !== undefined ? (
              <InlineError variant="compact" title="Add some details" message={errors.form} />
            ) : null}
            {saveError === null ? null : (
              <InlineError
                variant="compact"
                title={
                  original === null ? "Couldn’t create the contact" : "Couldn’t save the contact"
                }
                message={saveError}
              />
            )}
          </div>
        </div>
      </form>
      {unsaved}
    </section>
  );
}
