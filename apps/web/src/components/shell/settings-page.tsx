/* SettingsPage — full-screen settings overlay (z-index 300).
   Ported from the design handoff (overlays.jsx → SettingsPage).
   Sections: Profile, Appearance, Language, Notifications, Mail signature,
   Helix AI (the AI provider config), Security, Keyboard shortcuts. */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icons, type IconName } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { sessionUserQueryOptions } from "@/lib/auth";
import {
  ACCENT_OPTIONS,
  FONT_SCALE_OPTIONS,
  setAppearance,
  useAppearance,
  type Density,
  type ThemeMode,
} from "@/components/settings-store";
import type { SettingsSectionId } from "@/components/shell/overlay-context";

/* ---------- shared bits ---------- */

function SettingsField({
  label,
  hint,
  controlId,
  children,
}: {
  label: string;
  hint?: string;
  controlId?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 24,
        padding: "16px 0",
        borderTop: "1px solid var(--border)",
        alignItems: "flex-start",
      }}
    >
      <div>
        {controlId === undefined ? (
          <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 500 }}>{label}</div>
        ) : (
          <label
            htmlFor={controlId}
            style={{ display: "block", fontSize: "var(--text-body-sm)", fontWeight: 500 }}
          >
            {label}
          </label>
        )}
        {hint ? (
          <div
            style={{
              fontSize: "var(--text-caption)",
              color: "var(--text-3)",
              marginTop: 2,
              lineHeight: 1.5,
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

const SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE =
  "Account-backed settings are not available in this build yet.";

/* Spread onto every control whose value has nowhere to persist yet, so the
   disabled state and its explanation always travel together. */
const UNAVAILABLE_CONTROL_PROPS = {
  disabled: true,
  title: SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE,
} as const;

function Toggle({
  defaultOn,
  label,
  disabledReason,
}: {
  defaultOn: boolean;
  label: string;
  disabledReason?: string;
}) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      aria-description={disabledReason}
      title={disabledReason}
      disabled={disabledReason !== undefined}
      onClick={() => setOn((value) => !value)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        position: "relative",
        background: on ? "var(--accent)" : "var(--surface-3)",
        transition: "background 0.15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: "white",
          transition: "left 0.15s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
        }}
      />
    </button>
  );
}

function UnavailableSettingsButton({
  children,
  className = "btn sm",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={className}
      style={style}
      {...UNAVAILABLE_CONTROL_PROPS}
      aria-description={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
    >
      {children}
    </button>
  );
}

const h1Style = { fontSize: "var(--text-h2)", fontWeight: 600, margin: "0 0 4px" } as const;
const subStyle = {
  fontSize: "var(--text-body-sm)",
  color: "var(--text-3)",
  marginBottom: 8,
} as const;

const segmentedGroupStyle = {
  display: "flex",
  gap: 4,
  padding: 2,
  background: "var(--surface-2)",
  borderRadius: 6,
  width: "fit-content",
} as const;

/** Pill-style single-choice control (Density, Text size). */
function SegmentedControl<TValue extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: readonly { value: TValue; label: string }[];
  value: TValue;
  onSelect: (value: TValue) => void;
}) {
  return (
    <div role="group" aria-label={label} style={segmentedGroupStyle}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            aria-pressed={selected}
            style={{
              height: 28,
              padding: "0 16px",
              borderRadius: 4,
              fontSize: "var(--text-meta)",
              background: selected ? "var(--surface)" : "transparent",
              color: selected ? "var(--text)" : "var(--text-2)",
              fontWeight: selected ? 600 : 400,
              boxShadow: selected ? "var(--shadow-sm)" : "none",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Label + description on the left, a switch on the right. `style` carries the
    caller's row padding and separator borders. */
function ToggleRow({
  label,
  desc,
  defaultOn,
  style,
}: {
  label: string;
  desc: string;
  defaultOn: boolean;
  style: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", ...style }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 2 }}>
          {desc}
        </div>
      </div>
      <Toggle
        defaultOn={defaultOn}
        label={label}
        disabledReason={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
      />
    </div>
  );
}

/* ---------- Profile ---------- */

function ProfileSection() {
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const displayName = sessionQuery.data?.name ?? "";
  return (
    <>
      <h1 style={h1Style}>Profile</h1>
      <div style={subStyle}>How you appear across the workspace</div>
      <SettingsField label="Photo" hint="PNG or JPG, max 5 MB">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Avatar name={displayName || "You"} size={64} />
          <div>
            <UnavailableSettingsButton>Upload</UnavailableSettingsButton>
            <UnavailableSettingsButton className="btn sm ghost" style={{ marginLeft: 4 }}>
              Remove
            </UnavailableSettingsButton>
          </div>
        </div>
      </SettingsField>
      <SettingsField label="Display name" controlId="settings-display-name">
        <input
          id="settings-display-name"
          name="displayName"
          autoComplete="name"
          className="input"
          defaultValue={displayName}
          key={displayName}
          {...UNAVAILABLE_CONTROL_PROPS}
        />
      </SettingsField>
      <SettingsField label="Pronouns" controlId="settings-pronouns">
        <input
          id="settings-pronouns"
          name="pronouns"
          autoComplete="off"
          className="input"
          defaultValue=""
          placeholder="For example, they/them…"
          {...UNAVAILABLE_CONTROL_PROPS}
        />
      </SettingsField>
      <SettingsField label="Job title" controlId="settings-job-title">
        <input
          id="settings-job-title"
          name="jobTitle"
          autoComplete="organization-title"
          className="input"
          defaultValue=""
          placeholder="For example, Product Designer…"
          {...UNAVAILABLE_CONTROL_PROPS}
        />
      </SettingsField>
      <SettingsField
        label="About"
        hint="A short bio shown on your contact card"
        controlId="settings-about"
      >
        <textarea
          id="settings-about"
          name="about"
          autoComplete="off"
          className="input"
          defaultValue=""
          placeholder="For example, Building the next Helix release…"
          rows={3}
          {...UNAVAILABLE_CONTROL_PROPS}
          style={{
            height: "auto",
            padding: 10,
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />
      </SettingsField>
    </>
  );
}

/* ---------- Appearance ---------- */

const DENSITY_OPTIONS: readonly { value: Density; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Roomy" },
];

const THEME_OPTIONS: readonly { v: ThemeMode; label: string; swatch: [string, string] }[] = [
  { v: "light", label: "Light", swatch: ["#fafaf9", "#1c1917"] },
  { v: "dark", label: "Dark", swatch: ["#0a0a0b", "#ededee"] },
];

function AppearanceSection() {
  const theme = useAppearance((s) => s.theme);
  const density = useAppearance((s) => s.density);
  const fontScale = useAppearance((s) => s.fontScale);
  const accent = useAppearance((s) => s.accent);

  return (
    <>
      <h1 style={h1Style}>Appearance</h1>
      <div style={subStyle}>Personalize how Helix looks for you</div>
      <SettingsField label="Theme" hint="Choose light or dark mode">
        <div role="group" aria-label="Theme" style={{ display: "flex", gap: 12 }}>
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.v}
              type="button"
              onClick={() => setAppearance("theme", option.v)}
              aria-pressed={theme === option.v}
              style={{
                border: `2px solid ${theme === option.v ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 8,
                padding: 8,
                background: "var(--surface)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                width: 120,
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: 60,
                  borderRadius: 4,
                  position: "relative",
                  background: option.swatch[0],
                  border: "1px solid var(--border)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 6,
                    left: 6,
                    right: 30,
                    height: 6,
                    background: option.swatch[1],
                    borderRadius: 1,
                    opacity: 0.9,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: 18,
                    left: 6,
                    right: 18,
                    height: 3,
                    background: option.swatch[1],
                    borderRadius: 1,
                    opacity: 0.5,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: 26,
                    left: 6,
                    right: 30,
                    height: 3,
                    background: option.swatch[1],
                    borderRadius: 1,
                    opacity: 0.5,
                  }}
                />
              </div>
              <span style={{ fontSize: "var(--text-meta)", fontWeight: 500 }}>{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsField>
      <SettingsField label="Density" hint="How tightly content is packed">
        <SegmentedControl
          label="Density"
          options={DENSITY_OPTIONS}
          value={density}
          onSelect={(next) => setAppearance("density", next)}
        />
      </SettingsField>
      <SettingsField label="Text size" hint="Scale text across the entire workspace">
        <SegmentedControl
          label="Text size"
          options={FONT_SCALE_OPTIONS}
          value={fontScale}
          onSelect={(next) => setAppearance("fontScale", next)}
        />
      </SettingsField>
      <SettingsField label="Accent color" hint="Used for buttons, selections, and highlights">
        <div
          role="group"
          aria-label="Accent color"
          style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
        >
          {ACCENT_OPTIONS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => setAppearance("accent", color)}
              aria-label={`Accent ${color}`}
              aria-pressed={accent === color}
              title={color}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                padding: 0,
                border: "none",
                background: color,
                cursor: "pointer",
                boxShadow:
                  accent === color
                    ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
                    : "inset 0 0 0 1px rgba(0,0,0,0.08)",
                transition: "box-shadow 0.15s",
              }}
            />
          ))}
        </div>
      </SettingsField>
    </>
  );
}

/* ---------- Language ---------- */

function LanguageSection() {
  return (
    <>
      <h1 style={h1Style}>Language &amp; region</h1>
      <div style={subStyle}>How dates, times, and language are formatted</div>
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="input"
            name="workingHoursStart"
            type="time"
            autoComplete="off"
            aria-label="Working hours start"
            defaultValue="09:00"
            style={{ width: 100 }}
            {...UNAVAILABLE_CONTROL_PROPS}
          />
          <span style={{ color: "var(--text-3)" }}>to</span>
          <input
            className="input"
            name="workingHoursEnd"
            type="time"
            autoComplete="off"
            aria-label="Working hours end"
            defaultValue="18:00"
            style={{ width: 100 }}
            {...UNAVAILABLE_CONTROL_PROPS}
          />
          <span style={{ color: "var(--text-3)", fontSize: "var(--text-meta)" }}>Mon–Fri</span>
        </div>
      </SettingsField>
    </>
  );
}

/* ---------- Notifications ---------- */

function NotifySection() {
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
      <h1 style={h1Style}>Notifications</h1>
      <div style={subStyle}>What you get notified about and where</div>
      {rows.map((row, index) => (
        <ToggleRow
          key={row.label}
          label={row.label}
          desc={row.desc}
          defaultOn={row.on}
          style={{
            padding: "12px 0",
            borderTop: index ? "1px solid var(--border)" : "none",
            borderBottom: index === rows.length - 1 ? "1px solid var(--border)" : "none",
          }}
        />
      ))}
    </>
  );
}

/* ---------- Mail signature ---------- */

function SignatureSection() {
  return (
    <>
      <h1 style={h1Style}>Mail signature</h1>
      <div style={subStyle}>Added to every email you send from Helix Mail</div>
      <SettingsField label="Signature" controlId="settings-mail-signature">
        <textarea
          id="settings-mail-signature"
          name="mailSignature"
          autoComplete="off"
          className="input"
          defaultValue=""
          placeholder="For example, Thanks, Morgan…"
          rows={5}
          {...UNAVAILABLE_CONTROL_PROPS}
          style={{
            height: "auto",
            padding: 10,
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.5,
            fontSize: "var(--text-body-sm)",
          }}
        />
      </SettingsField>
      <SettingsField label="Reply behavior" controlId="settings-reply-signature">
        <select
          id="settings-reply-signature"
          name="replySignature"
          className="select"
          {...UNAVAILABLE_CONTROL_PROPS}
        >
          <option>Include signature on replies</option>
          <option>Skip on replies</option>
        </select>
      </SettingsField>
    </>
  );
}

/* ---------- Security ---------- */

function SecuritySection() {
  const sessions = [
    {
      device: "MacBook Pro · Safari",
      loc: "San Francisco, CA",
      time: "now",
      current: true,
    },
    {
      device: "iPhone 15 · Helix iOS",
      loc: "San Francisco, CA",
      time: "2h ago",
      current: false,
    },
    {
      device: "Windows · Chrome",
      loc: "Portland, OR",
      time: "Yesterday",
      current: false,
    },
  ];
  return (
    <>
      <h1 style={h1Style}>Security</h1>
      <div style={subStyle}>Authentication and active sessions</div>
      <SettingsField label="Multi-factor authentication" hint="Required by your organization">
        <span className="chip success">
          <span className="chip-dot" />
          Enrolled · YubiKey + TOTP
        </span>
        <UnavailableSettingsButton style={{ marginLeft: 8 }}>Manage</UnavailableSettingsButton>
      </SettingsField>
      <SettingsField
        label="Recovery codes"
        hint="Stored offline, used if your second factor is unavailable"
      >
        <UnavailableSettingsButton>View recovery codes</UnavailableSettingsButton>
      </SettingsField>
      <SettingsField label="Active sessions" hint="Devices currently signed in">
        <div className="panel">
          {sessions.map((session, index) => (
            <div
              key={session.device}
              style={{
                padding: "10px 12px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                borderTop: index ? "1px solid var(--border)" : "none",
                fontSize: "var(--text-meta)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>
                  {session.device}
                  {session.current ? (
                    <span className="chip accent" style={{ marginLeft: 6 }}>
                      This device
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
                  {session.loc} · {session.time}
                </div>
              </div>
              {!session.current ? (
                <UnavailableSettingsButton>Sign out</UnavailableSettingsButton>
              ) : null}
            </div>
          ))}
        </div>
      </SettingsField>
    </>
  );
}

/* ---------- Helix AI (provider config) ---------- */

interface AiProvider {
  id: string;
  name: string;
  desc: string;
  needsKey: boolean;
  host?: string;
  placeholder?: string;
}

const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: "helix",
    name: "Helix AI (managed)",
    desc: "Default. Uses our hosted models — Helix Pro, Fast, Reason.",
    needsKey: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    desc: "Use your own OpenAI API key. Routes all AI features through OpenAI.",
    needsKey: true,
    host: "api.openai.com/v1",
    placeholder: "For example, sk-…",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    desc: "Use your own Anthropic API key. Routes all AI features through Claude.",
    needsKey: true,
    host: "api.anthropic.com/v1",
    placeholder: "For example, sk-ant-…",
  },
  {
    id: "google",
    name: "Google Gemini",
    desc: "Use your own Google AI API key.",
    needsKey: true,
    host: "generativelanguage.googleapis.com",
    placeholder: "For example, AIza…",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    desc: "Enterprise — point at your own Azure OpenAI deployment.",
    needsKey: true,
    host: "your-resource.openai.azure.com",
    placeholder: "Azure deployment URL",
  },
  {
    id: "custom",
    name: "Custom endpoint",
    desc: "Self-hosted or third-party endpoint (OpenAI-compatible API).",
    needsKey: true,
    host: "https://your-endpoint",
    placeholder: "Bearer token or API key",
  },
];

/* Model ids offered per bring-your-own-key provider. Providers absent from
   this map (custom endpoints) fall back to the generic placeholder. */
const AI_PROVIDER_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3", "o4-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  azure: ["(your deployment names)"],
};

function AiModelOptions({ provider }: { provider: string }) {
  const models = AI_PROVIDER_MODELS[provider] ?? ["(your model id)"];
  return (
    <>
      {models.map((model) => (
        <option key={model}>{model}</option>
      ))}
    </>
  );
}

function PrivacyCheckbox({
  name,
  label,
  desc,
  defaultChecked = false,
}: {
  name: string;
  label: string;
  desc: ReactNode;
  defaultChecked?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        fontSize: "var(--text-meta)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        {...UNAVAILABLE_CONTROL_PROPS}
        style={{ accentColor: "var(--accent)", marginTop: 2 }}
      />
      <div>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ color: "var(--text-3)", marginTop: 2 }}>{desc}</div>
      </div>
    </label>
  );
}

function AISection() {
  const [provider, setProvider] = useState("helix");

  const selected = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0]!;

  const features = [
    {
      label: "Smart compose in Mail",
      desc: "Inline writing suggestions and draft replies",
      on: true,
    },
    { label: "Slash commands in Docs", desc: "/ai prompt inside any document", on: true },
    {
      label: "Formula generation in Sheets",
      desc: "Natural language → spreadsheet formulas",
      on: true,
    },
    {
      label: "Meeting summaries in Meet",
      desc: "Post-call recap with action items",
      on: true,
    },
    { label: "Smart replies in Chat", desc: "Suggested replies in DMs and spaces", on: false },
  ];

  return (
    <>
      <h1 style={h1Style}>Helix AI</h1>
      <div style={subStyle}>Connect Helix AI to your preferred model provider</div>

      <SettingsField label="Provider" hint="Where AI requests are sent">
        <div style={{ display: "grid", gap: 6 }}>
          {AI_PROVIDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setProvider(option.id)}
              aria-pressed={provider === option.id}
              aria-description={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
              title={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
              disabled
              style={{
                display: "flex",
                gap: 12,
                padding: "10px 12px",
                textAlign: "left",
                border: `1px solid ${provider === option.id ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 8,
                background: provider === option.id ? "var(--accent-soft)" : "var(--surface)",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 999,
                  marginTop: 2,
                  flexShrink: 0,
                  border: `5px solid ${provider === option.id ? "var(--accent)" : "var(--border-2)"}`,
                  background: provider === option.id ? "var(--accent)" : "transparent",
                  boxShadow:
                    provider === option.id
                      ? "inset 0 0 0 3px var(--surface)"
                      : "inset 0 0 0 4px var(--surface)",
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 600 }}>
                  {option.name}
                </div>
                <div
                  style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 2 }}
                >
                  {option.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      </SettingsField>

      {selected.needsKey ? (
        <>
          <SettingsField
            label="Endpoint"
            hint="Base URL for API requests"
            controlId="settings-ai-endpoint"
          >
            <input
              id="settings-ai-endpoint"
              name="aiEndpoint"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="input mono"
              defaultValue={selected.host}
              {...UNAVAILABLE_CONTROL_PROPS}
            />
          </SettingsField>
          <SettingsField
            label="API key"
            hint="Stored encrypted. Never sent to Helix servers."
            controlId="settings-ai-api-key"
          >
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="settings-ai-api-key"
                name="aiApiKey"
                className="input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={selected.placeholder}
                style={{ flex: 1 }}
                {...UNAVAILABLE_CONTROL_PROPS}
              />
              <UnavailableSettingsButton className="btn">Test Connection</UnavailableSettingsButton>
            </div>
          </SettingsField>
          <SettingsField label="Default model" controlId="settings-ai-model">
            <select
              id="settings-ai-model"
              name="aiModel"
              className="select"
              {...UNAVAILABLE_CONTROL_PROPS}
            >
              <AiModelOptions provider={provider} />
            </select>
          </SettingsField>
        </>
      ) : (
        <SettingsField label="Default model" controlId="settings-ai-model">
          <select
            id="settings-ai-model"
            name="aiModel"
            className="select"
            {...UNAVAILABLE_CONTROL_PROPS}
          >
            <option>Helix Pro — best for analysis and writing</option>
            <option>Helix Fast — quick responses, lower cost</option>
            <option>Helix Reason — multi-step reasoning + planning</option>
          </select>
        </SettingsField>
      )}

      <SettingsField label="Features" hint="Where AI can be used across the workspace">
        {features.map((feature, index) => (
          <ToggleRow
            key={feature.label}
            label={feature.label}
            desc={feature.desc}
            defaultOn={feature.on}
            style={{
              padding: "10px 0",
              borderTop: index ? "1px solid var(--border)" : "none",
            }}
          />
        ))}
      </SettingsField>

      <SettingsField label="Privacy" hint="Control what data is shared with the provider">
        <div style={{ display: "grid", gap: 8 }}>
          <PrivacyCheckbox
            name="aiWorkspaceContext"
            defaultChecked
            label="Use my workspace content for context"
            desc="Mail, docs, and files referenced in prompts."
          />
          <PrivacyCheckbox
            name="aiProviderTraining"
            label="Allow provider to train on my data"
            desc={<>Off by default. Most providers don&apos;t train on enterprise data anyway.</>}
          />
        </div>
      </SettingsField>
    </>
  );
}

/* ---------- Keyboard shortcuts ---------- */

function ShortcutsSection() {
  const groups = [
    {
      name: "Global",
      shortcuts: [
        ["⌘ K", "Open command palette"],
        ["⌘ /", "Show keyboard shortcuts"],
        ["G then M", "Go to Mail"],
        ["G then D", "Go to Docs"],
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
    {
      name: "Docs",
      shortcuts: [
        ["⌘ B", "Bold"],
        ["⌘ I", "Italic"],
        ["⌘ ⇧ K", "Insert link"],
        ["⌘ ⇧ M", "Add comment"],
        ["⌘ ⇧ S", "Share"],
        ["/", "Slash menu"],
      ],
    },
  ];
  return (
    <>
      <h1 style={{ fontSize: "var(--text-h2)", fontWeight: 600, margin: "0 0 16px" }}>
        Keyboard shortcuts
      </h1>
      {groups.map((group) => (
        <div key={group.name} style={{ marginBottom: 24 }}>
          <div className="section-label" style={{ padding: "0 0 8px" }}>
            {group.name}
          </div>
          <div className="panel">
            {group.shortcuts.map(([kbd, desc], index) => (
              <div
                key={desc}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 14px",
                  borderTop: index ? "1px solid var(--border)" : "none",
                  fontSize: "var(--text-meta)",
                }}
              >
                <span style={{ flex: 1 }}>{desc}</span>
                <span className="kbd">{kbd}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ---------- shell ---------- */

const SECTIONS: {
  id: SettingsSectionId;
  label: string;
  icon: IconName;
  Component: () => ReactNode;
}[] = [
  { id: "profile", label: "Profile", icon: "Users", Component: ProfileSection },
  { id: "appearance", label: "Appearance", icon: "Sun", Component: AppearanceSection },
  { id: "language", label: "Language & region", icon: "Globe", Component: LanguageSection },
  { id: "notify", label: "Notifications", icon: "Bell", Component: NotifySection },
  { id: "signature", label: "Mail signature", icon: "EditPen", Component: SignatureSection },
  { id: "ai", label: "Helix AI", icon: "Sparkles", Component: AISection },
  { id: "security", label: "Security", icon: "Shield", Component: SecuritySection },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "Code", Component: ShortcutsSection },
];

export interface SettingsPageProps {
  open: boolean;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onClose: () => void;
}

const SETTINGS_FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SettingsPage({ open, section, onSectionChange, onClose }: SettingsPageProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    let cancelled = false;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => {
      if (!cancelled) {
        dialogRef.current?.querySelector<HTMLElement>(SETTINGS_FOCUSABLE)?.focus();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) {
        return;
      }
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const activeSection = SECTIONS.find((entry) => entry.id === section);
  const ActiveSectionBody = activeSection?.Component;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg)",
        zIndex: 300,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 12,
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back">
          <Icons.ArrowLeft />
        </button>
        <span id="settings-title" style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>
          Settings
        </span>
        <div style={{ marginLeft: "auto" }}>
          <button type="button" className="btn primary sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <nav
          aria-label="Settings sections"
          style={{
            width: 240,
            borderRight: "1px solid var(--border)",
            background: "var(--surface)",
            padding: 12,
          }}
        >
          {SECTIONS.map((entry) => {
            const Icon = Icons[entry.icon];
            const selected = section === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSectionChange(entry.id)}
                aria-current={selected ? "page" : undefined}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  height: 32,
                  padding: "0 10px",
                  borderRadius: 6,
                  fontSize: "var(--text-body-sm)",
                  background: selected ? "var(--accent-soft)" : "transparent",
                  color: selected ? "var(--accent)" : "var(--text)",
                  fontWeight: selected ? 600 : 400,
                  textAlign: "left",
                }}
              >
                <Icon />
                {entry.label}
              </button>
            );
          })}
        </nav>
        <main
          aria-label={`${activeSection?.label ?? "Settings"} settings`}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 32px",
            maxWidth: 720,
            minWidth: 0,
          }}
        >
          {ActiveSectionBody ? <ActiveSectionBody /> : null}
        </main>
      </div>
    </div>
  );
}
