import { StatusEditor } from "@/features/presence/status-editor";
/* Profile (the account home) and Personal info. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronRight,
  Globe,
  IdCard,
  KeyRound,
  Mail,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { ProfileForm } from "@/components/profile-form";
import { Avatar } from "@/components/ui/avatar";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { accountPreferencesQueryOptions } from "@/features/account/queries";
import { useDateTimeFormat } from "@/features/account/use-date-time-format";
import { sessionQueryKeys, type SessionUser } from "@/lib/auth";
import {
  profileQueryKeys,
  profileQueryOptions,
  updateProfile,
  type ProfileUpdate,
  type UserProfile,
} from "@/lib/profile";
import type { SettingsSectionId } from "./overlay-context";
import { SettingsAvatarEditor } from "./settings-avatar";
import { SettingsCard, SettingsHeader, SettingsValueRow } from "./settings-controls";
import type { SettingsSectionProps } from "./settings-sections";

/** The signed-in profile and a save that keeps every cached copy in step. */
function useProfile() {
  const queryClient = useQueryClient();
  const query = useQuery(profileQueryOptions());
  const save = async (input: ProfileUpdate): Promise<UserProfile> => {
    const updated = await updateProfile(input);
    queryClient.setQueryData(profileQueryKeys.current, updated);
    queryClient.setQueryData<SessionUser | null>(sessionQueryKeys.current, (current) =>
      current ? { ...current, name: updated.displayName, actorId: updated.actorId } : current,
    );
    void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.current });
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    void queryClient.invalidateQueries({ queryKey: ["people"] });
    void queryClient.invalidateQueries({ queryKey: profileQueryKeys.byActor(updated.actorId) });
    return updated;
  };
  return { query, save };
}

function ProfileLoadState({ query }: { readonly query: ReturnType<typeof useProfile>["query"] }) {
  const queryClient = useQueryClient();
  return query.isError ? (
    <InlineError
      title="Your profile didn’t load"
      message={query.error.message}
      retrying={query.isFetching}
      onRetry={() => {
        void queryClient.invalidateQueries({ queryKey: profileQueryKeys.current });
      }}
    />
  ) : (
    <Skeleton variant="card" count={2} label="Loading profile" />
  );
}

/* ---------- Profile (home) ---------- */

export function ProfileHomeSection({ onNavigate }: SettingsSectionProps) {
  const { query } = useProfile();
  const profile = query.data;
  const preferences = useQuery(accountPreferencesQueryOptions()).data;
  const format = useDateTimeFormat();
  if (profile === undefined) return <ProfileLoadState query={query} />;
  return (
    <>
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <Avatar
          name={profile.displayName}
          size={96}
          alt={`Profile photo of ${profile.displayName}`}
          {...(profile.avatarDataUrl === null ? {} : { src: profile.avatarDataUrl })}
        />
        <h1 className="m-0 type-h1 font-semibold">Welcome, {profile.displayName}</h1>
        <p className="m-0 type-body-sm text-muted-foreground">{profile.email}</p>
      </div>
      <StatusEditor />
      <div className="grid gap-3 @container sm:grid-cols-2">
        <HomeCard
          icon={<IdCard size={20} aria-hidden="true" />}
          title="Personal info"
          body="Your photo, name and the details people see about you."
          target="personal-info"
          onNavigate={onNavigate}
        />
        <HomeCard
          icon={<ShieldCheck size={20} aria-hidden="true" />}
          title="Security"
          body="Password, the devices you’re signed in on, passkeys and 2-step verification."
          target="security"
          onNavigate={onNavigate}
        />
        <HomeCard
          icon={<Globe size={20} aria-hidden="true" />}
          title="Language & region"
          body={`${format.timeZone.replaceAll("_", " ")} · ${
            format.hour12 ? "12-hour clock" : "24-hour clock"
          }${preferences?.timeZone == null ? " (from this device)" : ""}`}
          target="language"
          onNavigate={onNavigate}
        />
        <HomeCard
          icon={<KeyRound size={20} aria-hidden="true" />}
          title="App passwords"
          body="Let mail, calendar and file apps sign in without your main password."
          target="app-passwords"
          onNavigate={onNavigate}
        />
      </div>
      <SettingsCard
        className="mt-4"
        title="App settings"
        description="Settings that belong to one app"
      >
        <SettingsValueRow
          label="Mail"
          value="Reading pane, conversations, signature, labels and filters"
          action={
            <button type="button" className="btn sm" onClick={() => onNavigate("mail/general")}>
              <Mail size={14} aria-hidden="true" />
              Mail settings
            </button>
          }
        />
        <SettingsValueRow
          label="Calendar"
          value="Time zone, start of week and working hours"
          action={
            <button type="button" className="btn sm" onClick={() => onNavigate("language")}>
              <CalendarDays size={14} aria-hidden="true" />
              Calendar settings
            </button>
          }
        />
      </SettingsCard>
    </>
  );
}

function HomeCard({
  icon,
  title,
  body,
  target,
  onNavigate,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly target: SettingsSectionId;
  readonly onNavigate: (section: SettingsSectionId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(target)}
      className="focus-ring flex items-start gap-3 rounded-xl border border-border bg-card text-left [padding:16px] hover:bg-muted"
    >
      <span className="mt-0.5 text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block type-body font-semibold">{title}</span>
        <span className="block type-body-sm text-muted-foreground">{body}</span>
      </span>
      <ChevronRight size={18} aria-hidden="true" className="mt-0.5 text-muted-foreground" />
    </button>
  );
}

/* ---------- Personal info ---------- */

export function PersonalInfoSection() {
  const { query, save } = useProfile();
  const profile = query.data;
  return (
    <>
      <SettingsHeader
        title="Personal info"
        description="How you appear to people across the workspace"
      />
      {profile === undefined ? (
        <ProfileLoadState query={query} />
      ) : (
        <>
          <SettingsCard title="Profile photo" description="Shown next to your name everywhere">
            <SettingsAvatarEditor
              name={profile.displayName}
              avatarDataUrl={profile.avatarDataUrl}
              onSave={async (avatarDataUrl) => {
                await save({ avatarDataUrl });
              }}
            />
          </SettingsCard>
          <SettingsCard title="About you" description="People see these on your profile card">
            <ProfileForm key={profile.actorId} profile={profile} onSave={save} />
          </SettingsCard>
          <SettingsCard title="Contact info">
            <SettingsValueRow
              label="Email"
              value={
                <>
                  <span className="block">{profile.email ?? "No email address"}</span>
                  <span className="block type-caption text-muted-foreground">
                    Your sign-in address. Your administrator manages it.
                  </span>
                </>
              }
            />
          </SettingsCard>
        </>
      )}
    </>
  );
}
