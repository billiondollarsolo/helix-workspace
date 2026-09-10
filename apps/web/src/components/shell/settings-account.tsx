import { ProfileForm } from "@/components/profile-form";
import { Avatar } from "@/components/ui/avatar";
import { setMailUserSettings } from "@/features/mail/api";
import { mailUserSettingsQueryOptions } from "@/features/mail/queries";
import { sessionQueryKeys, type SessionUser } from "@/lib/auth";
import { profileQueryKeys, profileQueryOptions, updateProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SettingsField, ToggleRow, UNAVAILABLE_CONTROL_PROPS } from "./settings-controls";

/* ---------- Profile ---------- */

export function ProfileSection() {
  const queryClient = useQueryClient();
  const profileQuery = useQuery(profileQueryOptions());
  const profile = profileQuery.data;
  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">Profile</h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-4">
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
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">
        Language &amp; region
      </h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-2">
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
          <span className="text-muted-foreground [font-size:var(--text-meta)]">Mon–Fri</span>
        </div>
      </SettingsField>
    </>
  );
}

/* ---------- Notifications ---------- */

export function NotifySection() {
  const rows = [
    { label: "@mentions and DMs", desc: "Always notify", on: true },
    {
      label: "Document comments",
      desc: "Notify when someone replies to your comment",
      on: true,
    },
    {
      label: "Shared with you",
      desc: "When a doc, sheet, or deck is shared with you",
      on: true,
    },
    { label: "Calendar reminders", desc: "10 minutes before events", on: true },
    { label: "Weekly digest", desc: "Monday morning summary", on: false },
    { label: "Marketing emails", desc: "Product updates and tips", on: false },
  ];
  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">Notifications</h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-2">
        What you get notified about and where
      </div>
      {rows.map((row, index) => (
        <ToggleRow
          key={row.label}
          label={row.label}
          desc={row.desc}
          defaultOn={row.on}
          className={cn(
            "[padding:12px_0]",
            index ? "[border-top:1px_solid_var(--border)]" : "[border-top:none]",
            index === rows.length - 1
              ? "[border-bottom:1px_solid_var(--border)]"
              : "[border-bottom:none]",
          )}
        />
      ))}
    </>
  );
}

/* ---------- Mail signature ---------- */

export function SignatureSection() {
  const settings = useQuery(mailUserSettingsQueryOptions());
  const [signatureText, setSignatureText] = useState("");
  const [includeOnReplies, setIncludeOnReplies] = useState(true);
  const [blockedSenders, setBlockedSenders] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data === undefined) return;
    setSignatureText(settings.data.signatureText);
    setIncludeOnReplies(settings.data.includeSignatureOnReplies);
    setBlockedSenders(settings.data.blockedSenders.join("\n"));
  }, [settings.data]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await setMailUserSettings({
        signatureText,
        signatureHtml: null,
        includeSignatureOnReplies: includeOnReplies,
        blockedSenders: blockedSenders
          .split(/[\s,]+/u)
          .map((address) => address.trim().toLowerCase())
          .filter(Boolean),
      });
      setMessage("Mail settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save mail settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">Mail signature</h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-2">
        Added to every email you send from Helix Mail
      </div>
      <SettingsField label="Signature" controlId="settings-mail-signature">
        <textarea
          id="settings-mail-signature"
          name="mailSignature"
          autoComplete="off"
          className="input [height:auto] p-2.5 [resize:vertical] [font-family:inherit] [line-height:1.5] [font-size:var(--text-body-sm)]"
          value={signatureText}
          onChange={(event) => setSignatureText(event.target.value)}
          placeholder="For example, Thanks, Morgan…"
          rows={5}
          disabled={settings.isPending || saving}
        />
      </SettingsField>
      <SettingsField label="Reply behavior" controlId="settings-reply-signature">
        <select
          id="settings-reply-signature"
          name="replySignature"
          className="select"
          value={includeOnReplies ? "include" : "skip"}
          onChange={(event) => setIncludeOnReplies(event.target.value === "include")}
          disabled={settings.isPending || saving}
        >
          <option value="include">Include signature on replies</option>
          <option value="skip">Skip on replies</option>
        </select>
      </SettingsField>
      <SettingsField
        label="Blocked senders"
        hint="One email address per line; future messages go to Spam"
        controlId="settings-blocked-senders"
      >
        <textarea
          id="settings-blocked-senders"
          name="blockedSenders"
          autoComplete="off"
          className="input [height:auto] p-2.5 [resize:vertical] [font-family:inherit]"
          value={blockedSenders}
          onChange={(event) => setBlockedSenders(event.target.value)}
          rows={4}
          disabled={settings.isPending || saving}
        />
      </SettingsField>
      {settings.error !== null ? <div role="alert">{settings.error.message}</div> : null}
      {message !== null ? <div role="status">{message}</div> : null}
      <button
        type="button"
        className="btn primary sm"
        disabled={settings.isPending || saving}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save mail settings"}
      </button>
    </>
  );
}

/* ---------- Keyboard shortcuts ---------- */

export function ShortcutsSection() {
  const groups = [
    {
      name: "Global",
      shortcuts: [
        ["⌘ K", "Open command palette"],
        ["⌘ /", "Show keyboard shortcuts"],
        ["G then M", "Go to Mail"],
        ["G then C", "Go to Calendar"],
      ],
    },
    {
      name: "Mail",
      shortcuts: [
        ["C", "Compose"],
        ["E", "Archive"],
        ["#", "Delete"],
        ["R", "Reply"],
        ["A", "Reply all"],
        ["F", "Forward"],
        ["S", "Star"],
        ["B", "Snooze"],
      ],
    },
  ];
  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_16px]">
        Keyboard shortcuts
      </h1>
      {groups.map((group) => (
        <div key={group.name} className="mb-6">
          <div className="section-label [padding:0_0_8px]">{group.name}</div>
          <div className="panel">
            {group.shortcuts.map(([kbd, desc], index) => (
              <div
                key={desc}
                className={cn(
                  "flex items-center [padding:8px_14px] [font-size:var(--text-meta)]",
                  index ? "[border-top:1px_solid_var(--border)]" : "[border-top:none]",
                )}
              >
                <span className="flex-1">{desc}</span>
                <span className="kbd">{kbd}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
