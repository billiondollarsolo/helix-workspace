/* ProfileMenu — dropdown from the TopBar avatar. Ported from the design
   handoff (shell.jsx → ProfileMenu). User card + appearance controls
   (mode / density / accent) + account actions. */

import type { CSSProperties, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons, type IconComponent } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { sessionUserQueryOptions, signOut } from "@/lib/auth";
import type { SettingsSectionId } from "@/components/shell/overlay-context";
import { ACCENT_OPTIONS, setAppearance, useAppearance } from "@/components/settings-store";

export interface ProfileMenuProps {
  open: boolean;
  onClose: () => void;
  /** Avatar button that owns this popover. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  /** Open the full-screen settings page. */
  openSettings: (section?: SettingsSectionId) => void;
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
    fontSize: "var(--text-meta)",
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

export function ProfileMenu({ open, onClose, anchorRef, openSettings }: ProfileMenuProps) {
  const theme = useAppearance((s) => s.theme);
  const density = useAppearance((s) => s.density);
  const accent = useAppearance((s) => s.accent);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const displayName = sessionQuery.data?.name ?? sessionQuery.data?.email ?? "Signed in";
  const displayEmail = sessionQuery.data?.email ?? "";

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const firstControl = menu?.querySelector<HTMLButtonElement>("button:not([disabled])");
    queueMicrotask(() => firstControl?.focus());

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !menu?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [anchorRef, onClose, open]);

  if (!open) return null;

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
    {
      icon: Icons.Shield,
      label: "Privacy & security",
      action: () => {
        onClose();
        openSettings("security");
      },
    },
    {
      icon: Icons.Help,
      label: "Help & shortcuts",
      action: () => {
        onClose();
        openSettings("shortcuts");
      },
    },
  ];

  return (
    <div
      id="profile-menu"
      ref={menuRef}
      role="menu"
      aria-label="Profile & appearance"
      className="profile-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          anchorRef.current?.focus();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const controls = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
        );
        if (controls.length === 0) return;
        event.preventDefault();
        const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? controls.length - 1
              : event.key === "ArrowDown"
                ? (currentIndex + 1 + controls.length) % controls.length
                : (currentIndex - 1 + controls.length) % controls.length;
        controls[nextIndex]?.focus();
      }}
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
        <Avatar name={displayName} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>{displayName}</div>
          <div
            className="truncate"
            style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
          >
            {displayEmail}
          </div>
        </div>
      </div>

      {/* Appearance */}
      <div style={{ padding: "8px 12px 10px" }}>
        <div
          style={{
            fontSize: "var(--text-chip)",
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
          <div
            id="profile-theme-label"
            style={{ fontSize: "var(--text-caption)", color: "var(--text-2)", marginBottom: 4 }}
          >
            Mode
          </div>
          <div style={segmentWrap} role="group" aria-labelledby="profile-theme-label">
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
          <div
            id="profile-density-label"
            style={{ fontSize: "var(--text-caption)", color: "var(--text-2)", marginBottom: 4 }}
          >
            Density
          </div>
          <div style={segmentWrap} role="group" aria-labelledby="profile-density-label">
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
          <div
            id="profile-accent-label"
            style={{ fontSize: "var(--text-caption)", color: "var(--text-2)", marginBottom: 6 }}
          >
            Accent color
          </div>
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            role="group"
            aria-labelledby="profile-accent-label"
          >
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
              role="menuitem"
              onClick={item.action}
              className="profile-menu-action"
              style={{
                width: "100%",
                height: 34,
                padding: "0 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: "var(--text-meta)",
                color: "var(--text)",
                textAlign: "left",
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
          role="menuitem"
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
            fontSize: "var(--text-meta)",
            color: "var(--danger)",
            textAlign: "left",
            cursor: signingOut ? "default" : "pointer",
            opacity: signingOut ? 0.6 : 1,
          }}
          className="profile-menu-action"
        >
          <Icons.ArrowLeft />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
