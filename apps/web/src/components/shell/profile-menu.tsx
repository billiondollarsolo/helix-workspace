/* ProfileMenu — dropdown from the TopBar avatar. Ported from the design
   handoff (shell.jsx → ProfileMenu). User card + appearance controls
   (mode / density / accent) + account actions. */

import type { CSSProperties } from "react";
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Icons, type IconComponent } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { CURRENT_USER } from "@/components/people";
import { signOut } from "@/lib/auth";
import {
  ACCENT_OPTIONS,
  setAppearance,
  useAppearance,
} from "@/components/settings-store";

export interface ProfileMenuProps {
  open: boolean;
  onClose: () => void;
  /** Open the full-screen settings page. */
  openSettings: () => void;
}

function AccentSwatch({
  color,
  selected,
  onClick,
}: {
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Accent ${color}`}
      aria-pressed={selected}
      title={color}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        padding: 0,
        border: "none",
        background: color,
        cursor: "pointer",
        flexShrink: 0,
        boxShadow: selected
          ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
          : "inset 0 0 0 1px rgba(0,0,0,0.08)",
        transition: "box-shadow 0.1s",
      }}
    />
  );
}

const segmentWrap: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 2,
  background: "var(--surface-2)",
  borderRadius: 6,
};

function segmentButton(selected: boolean): CSSProperties {
  return {
    flex: 1,
    height: 28,
    borderRadius: 4,
    fontSize: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    background: selected ? "var(--surface)" : "transparent",
    color: selected ? "var(--text)" : "var(--text-2)",
    fontWeight: selected ? 600 : 400,
    boxShadow: selected ? "var(--shadow-sm)" : "none",
  };
}

export function ProfileMenu({ open, onClose, openSettings }: ProfileMenuProps) {
  const theme = useAppearance((s) => s.theme);
  const density = useAppearance((s) => s.density);
  const accent = useAppearance((s) => s.accent);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);

  if (!open) {
    return null;
  }

  const handleSignOut = async (): Promise<void> => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Drop any cached, actor-scoped data before leaving the workspace.
      queryClient.clear();
      onClose();
      await router.navigate({ to: "/login" });
      await router.invalidate();
    }
  };

  const modeOptions: { v: "light" | "dark"; label: string; icon: IconComponent }[] = [
    { v: "light", label: "Light", icon: Icons.Sun },
    { v: "dark", label: "Dark", icon: Icons.Moon },
  ];
  const densityOptions: { v: "compact" | "comfortable"; label: string }[] = [
    { v: "compact", label: "Compact" },
    { v: "comfortable", label: "Roomy" },
  ];
  const footerActions: { icon: IconComponent; label: string; action: () => void }[] = [
    {
      icon: Icons.Settings,
      label: "Account settings",
      action: () => {
        onClose();
        openSettings();
      },
    },
    { icon: Icons.Shield, label: "Privacy & security", action: onClose },
    { icon: Icons.Help, label: "Help & support", action: onClose },
  ];

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        top: 44,
        right: 8,
        width: 280,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 200,
        overflow: "hidden",
      }}
    >
      {/* User card */}
      <div
        style={{
          padding: "14px 14px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Avatar name={CURRENT_USER.name} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{CURRENT_USER.name}</div>
          <div className="truncate" style={{ fontSize: 11, color: "var(--text-3)" }}>
            {CURRENT_USER.email}
          </div>
        </div>
      </div>

      {/* Appearance */}
      <div style={{ padding: "8px 12px 10px" }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: ".06em",
            color: "var(--text-3)",
            padding: "4px 2px 8px",
          }}
        >
          Appearance
        </div>

        {/* Mode */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>Mode</div>
          <div style={segmentWrap}>
            {modeOptions.map((option) => {
              const Ico = option.icon;
              const selected = theme === option.v;
              return (
                <button
                  key={option.v}
                  type="button"
                  onClick={() => setAppearance("theme", option.v)}
                  aria-pressed={selected}
                  style={segmentButton(selected)}
                >
                  <Ico /> {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Density */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>Density</div>
          <div style={segmentWrap}>
            {densityOptions.map((option) => {
              const selected = density === option.v;
              return (
                <button
                  key={option.v}
                  type="button"
                  onClick={() => setAppearance("density", option.v)}
                  aria-pressed={selected}
                  style={segmentButton(selected)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Accent */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 6 }}>
            Accent color
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {ACCENT_OPTIONS.map((color) => (
              <AccentSwatch
                key={color}
                color={color}
                selected={accent === color}
                onClick={() => setAppearance("accent", color)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {footerActions.map((item) => {
          const Ico = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              onClick={item.action}
              style={{
                width: "100%",
                height: 34,
                padding: "0 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 12,
                color: "var(--text)",
                textAlign: "left",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = "var(--hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              <Ico />
              {item.label}
            </button>
          );
        })}
        <div style={{ height: 1, background: "var(--border)" }} />
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            void handleSignOut();
          }}
          style={{
            width: "100%",
            height: 34,
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            color: "var(--danger)",
            textAlign: "left",
            cursor: signingOut ? "default" : "pointer",
            opacity: signingOut ? 0.6 : 1,
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = "var(--hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "transparent";
          }}
        >
          <Icons.ArrowLeft />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
