import { ProfileForm } from "@/components/profile-form";
import { Avatar } from "@/components/ui/avatar";
import { sessionQueryKeys, type SessionUser } from "@/lib/auth";
import { profileQueryKeys, profileQueryOptions, updateProfile } from "@/lib/profile";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsField, UNAVAILABLE_CONTROL_PROPS } from "./settings-controls";

/* ---------- Profile ---------- */

export function ProfileSection() {
  const queryClient = useQueryClient();
  const profileQuery = useQuery(profileQueryOptions());
  const profile = profileQuery.data;
  return (
    <>
      <h1 className="type-h2 font-semibold [margin:0_0_4px]">Profile</h1>
      <div className="type-body-sm text-muted-foreground mb-4">
        How you appear across the workspace
      </div>
      {profile ? (
        <>
          <div className="mb-4 flex items-center gap-3">
            <Avatar name={profile.displayName} size={64} />
            <span className="text-muted-foreground">{profile.email}</span>
          </div>
          <ProfileForm
            key={profile.actorId}
            profile={profile}
            onSave={(input) => updateProfile(input)}
            onSaved={(updated) => {
              queryClient.setQueryData(profileQueryKeys.current, updated);
              queryClient.setQueryData<SessionUser | null>(sessionQueryKeys.current, (current) =>
                current
                  ? { ...current, name: updated.displayName, actorId: updated.actorId }
                  : current,
              );
              void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.current });
              void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
              void queryClient.invalidateQueries({ queryKey: ["people", "directory"] });
              void queryClient.invalidateQueries({
                queryKey: profileQueryKeys.byActor(updated.actorId),
              });
            }}
          />
        </>
      ) : profileQuery.isError ? (
        <div role="alert">
          <p>{profileQuery.error.message}</p>
          <button
            className="btn"
            type="button"
            disabled={profileQuery.isFetching}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: profileQueryKeys.current });
            }}
          >
            Retry loading profile
          </button>
        </div>
      ) : (
        <p role="status">Loading profile…</p>
      )}
    </>
  );
}

/* ---------- Language ---------- */

export function LanguageSection() {
  return (
    <>
      <h1 className="type-h2 font-semibold [margin:0_0_4px]">Language &amp; region</h1>
      <div className="type-body-sm text-muted-foreground mb-2">
        How dates, times, and language are formatted
      </div>
      <SettingsField label="Language" controlId="settings-language">
        <select
          id="settings-language"
          name="language"
          className="select"
          defaultValue="en-US"
          {...UNAVAILABLE_CONTROL_PROPS}
        >
          <option value="en-US">English (US)</option>
          <option value="en-GB">English (UK)</option>
          <option value="de-DE">Deutsch</option>
          <option value="fr-FR">Français</option>
          <option value="ja-JP">日本語</option>
        </select>
      </SettingsField>
      <SettingsField label="Time zone" controlId="settings-time-zone">
        <select
          id="settings-time-zone"
          name="timeZone"
          className="select"
          defaultValue="pt"
          {...UNAVAILABLE_CONTROL_PROPS}
        >
          <option value="pt">(GMT-08:00) America / Los Angeles</option>
          <option value="et">(GMT-05:00) America / New York</option>
          <option value="utc">(GMT+00:00) UTC</option>
          <option value="cet">(GMT+01:00) Europe / Berlin</option>
        </select>
      </SettingsField>
      <SettingsField label="First day of week" controlId="settings-week-start">
        <select
          id="settings-week-start"
          name="weekStart"
          className="select"
          defaultValue="mon"
          {...UNAVAILABLE_CONTROL_PROPS}
        >
          <option value="sun">Sunday</option>
          <option value="mon">Monday</option>
        </select>
      </SettingsField>
      <SettingsField label="Working hours">
        <div className="flex gap-2 items-center">
          <input
            className="input w-25"
            name="workingHoursStart"
            type="time"
            autoComplete="off"
            aria-label="Working hours start"
            defaultValue="09:00"

            {...UNAVAILABLE_CONTROL_PROPS}
          />
          <span className="text-muted-foreground">to</span>
          <input
            className="input w-25"
            name="workingHoursEnd"
            type="time"
            autoComplete="off"
            aria-label="Working hours end"
            defaultValue="18:00"

            {...UNAVAILABLE_CONTROL_PROPS}
          />
          <span className="text-muted-foreground type-meta">Mon–Fri</span>
        </div>
      </SettingsField>
    </>
  );
}
