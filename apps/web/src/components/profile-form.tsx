import { Button } from "@/components/ui/button";
import type { ProfileInput, UserProfile } from "@/lib/profile";
import { useId, useState, type FormEvent } from "react";

export function ProfileForm({
  profile,
  onSave,
  onSaved,
}: {
  readonly profile: UserProfile;
  readonly onSave: (input: ProfileInput) => Promise<UserProfile>;
  readonly onSaved?: (profile: UserProfile) => void;
}) {
  const id = useId();
  const [fields, setFields] = useState<ProfileInput>({
    displayName: profile.displayName,
    pronouns: profile.pronouns,
    jobTitle: profile.jobTitle,
    about: profile.about,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function change(field: keyof ProfileInput, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!fields.displayName.trim()) {
      setError("Enter a display name.");
      return;
    }
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await onSave(fields);
      setFields({
        displayName: updated.displayName,
        pronouns: updated.pronouns,
        jobTitle: updated.jobTitle,
        about: updated.about,
      });
      setSaved(true);
      onSaved?.(updated);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Your profile could not be saved. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
      aria-busy={pending}
      className="space-y-4"
    >
      <fieldset disabled={pending} className="m-0 space-y-4 border-0 p-0">
        <legend className="sr-only">Profile details</legend>
        <div className="space-y-1">
          <label htmlFor={`${id}-display-name`}>Display name</label>
          <input
            id={`${id}-display-name`}
            className="input w-full"
            name="displayName"
            autoComplete="name"
            required
            maxLength={200}
            value={fields.displayName}
            onChange={(event) => change("displayName", event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-pronouns`}>Pronouns</label>
          <input
            id={`${id}-pronouns`}
            className="input w-full"
            name="pronouns"
            autoComplete="off"
            maxLength={80}
            value={fields.pronouns}
            onChange={(event) => change("pronouns", event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-job-title`}>Job title</label>
          <input
            id={`${id}-job-title`}
            className="input w-full"
            name="jobTitle"
            autoComplete="organization-title"
            maxLength={200}
            value={fields.jobTitle}
            onChange={(event) => change("jobTitle", event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-about`}>About</label>
          <textarea
            id={`${id}-about`}
            className="input h-auto w-full resize-y"
            name="about"
            autoComplete="off"
            rows={3}
            maxLength={2000}
            value={fields.about}
            onChange={(event) => change("about", event.target.value)}
          />
        </div>
        <Button type="submit">{pending ? "Saving…" : "Save profile"}</Button>
      </fieldset>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? <p role="status">Profile saved.</p> : null}
    </form>
  );
}
