import { cn } from "@/lib/utils";
import {
  ArrowLeft as ArrowLeftIcon,
  CircleHelp as HelpIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  Settings as SettingsIcon,
  Shield as ShieldIcon,
  Sun as SunIcon,
  type LucideIcon as IconComponent,
} from "lucide-react";
/* ProfileMenu — dropdown from the TopBar avatar. Ported from the design
   handoff (shell.jsx → ProfileMenu). User card + appearance controls
   (mode / density / accent) + account actions. */

import {
  ACCENT_OPTIONS,
  DENSITY_OPTIONS,
  THEME_OPTIONS,
  accentSwatch,
  setAppearance,
  useAppearance,
  type ThemeMode,
} from "@/components/settings-store";
import type { SettingsSectionId } from "@/components/shell/overlay-context";
import { Avatar } from "@/components/ui/avatar";
import { sessionUserQueryOptions, signOut } from "@/lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

export interface ProfileMenuProps {
  open: boolean;
  onClose: () => void;
  /** Avatar button that owns this popover. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  /** Open the full-screen settings page. */
  openSettings: (section?: SettingsSectionId) => void;
}

function AccentSwatch({
  label,
  hue,
  selected,
  onClick,
}: {
  label: string;
  hue: number;
  selected: boolean;
  onClick: () => void;
}) {
  const color = accentSwatch(hue);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Accent ${label}`}
      aria-pressed={selected}
      title={label}
      className="w-6 h-6 rounded-md p-0 [border:none] cursor-pointer shrink-0 [transition:box-shadow_0.1s]"
      style={{
        background: color,
        boxShadow: selected
          ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
          : "inset 0 0 0 1px rgba(0,0,0,0.08)",
      }}
    />
  );
}

const MODE_ICONS: Readonly<Record<ThemeMode, IconComponent>> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

const MODE_OPTIONS = THEME_OPTIONS.map((option) => ({
  v: option.value,
  label: option.label,
  icon: MODE_ICONS[option.value],
}));

const DENSITY_CHOICES = DENSITY_OPTIONS.map((option) => ({ v: option.value, label: option.label }));

/** Labelled segmented control used for both Mode and Density. */
function SegmentedGroup<TValue extends string>({
  labelId,
  label,
  options,
  value,
  onSelect,
}: {
  labelId: string;
  label: string;
  options: readonly { v: TValue; label: string; icon?: IconComponent }[];
  value: TValue;
  onSelect: (value: TValue) => void;
}) {
  return (
    <div className="mb-2.5">
      <div id={labelId} className="type-caption [color:var(--text-2)] mb-1">
        {label}
      </div>
      <div className="flex gap-1 p-0.5 bg-muted rounded-md" role="group" aria-labelledby={labelId}>
        {options.map((option) => {
          const Ico = option.icon;
          const selected = value === option.v;
          return (
            <button
              key={option.v}
              type="button"
              onClick={() => onSelect(option.v)}
              aria-pressed={selected}
              className="flex-1 h-7 rounded type-meta flex items-center justify-center gap-1.5 bg-transparent [color:var(--text-2)] font-normal aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:font-semibold aria-pressed:[box-shadow:var(--shadow-sm)]"
            >
              {Ico ? (
                <>
                  <Ico size={16} /> {option.label}
                </>
              ) : (
                option.label
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Roving focus target for the menu's Arrow/Home/End keys. */
function rovingFocusIndex(key: string, currentIndex: number, count: number): number {
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return (currentIndex + 1 + count) % count;
    default:
      return (currentIndex - 1 + count) % count;
  }
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

  const footerActions: { icon: IconComponent; label: string; action: () => void }[] = [
    {
      icon: SettingsIcon,
      label: "Account settings",
      action: () => {
        onClose();
        openSettings();
      },
    },
    {
      icon: ShieldIcon,
      label: "Privacy & security",
      action: () => {
        onClose();
        openSettings("security");
      },
    },
    {
      icon: HelpIcon,
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
      className="profile-menu absolute top-11 right-2 w-70 bg-card [border:1px_solid_var(--border)] [border-radius:10px] [box-shadow:var(--shadow-lg)] [z-index:200] overflow-hidden"
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
        controls[rovingFocusIndex(event.key, currentIndex, controls.length)]?.focus();
      }}
    >
      {/* User card */}
      <div className="[padding:14px_14px_12px] flex items-center gap-2.5 [border-bottom:1px_solid_var(--border)]">
        <Avatar name={displayName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold type-body-sm">{displayName}</div>
          <div className="truncate type-caption text-muted-foreground">{displayEmail}</div>
        </div>
      </div>

      {/* Appearance */}
      <div className="[padding:8px_12px_10px]">
        <div className="type-chip font-semibold uppercase [letter-spacing:.06em] text-muted-foreground [padding:4px_2px_8px]">
          Appearance
        </div>

        {/* Mode */}
        <SegmentedGroup
          labelId="profile-theme-label"
          label="Mode"
          options={MODE_OPTIONS}
          value={theme}
          onSelect={(next) => setAppearance("theme", next)}
        />

        {/* Density */}
        <SegmentedGroup
          labelId="profile-density-label"
          label="Density"
          options={DENSITY_CHOICES}
          value={density}
          onSelect={(next) => setAppearance("density", next)}
        />

        {/* Accent */}
        <div>
          <div id="profile-accent-label" className="type-caption [color:var(--text-2)] mb-1 mb-1.5">
            Accent color
          </div>
          <div className="flex gap-2 flex-wrap" role="group" aria-labelledby="profile-accent-label">
            {ACCENT_OPTIONS.map((option) => (
              <AccentSwatch
                key={option.value}
                label={option.label}
                hue={option.hue}
                selected={accent === option.value}
                onClick={() => setAppearance("accent", option.value)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="[border-top:1px_solid_var(--border)]">
        {footerActions.map((item) => {
          const Ico = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={item.action}
              className="profile-menu-action w-full h-8.5 [padding:0_14px] flex items-center gap-2.5 type-meta text-left text-foreground"
            >
              <Ico size={16} />
              {item.label}
            </button>
          );
        })}
        <div className="[height:1px] [background:var(--border)]" />
        <button
          type="button"
          role="menuitem"
          disabled={signingOut}
          onClick={() => {
            void handleSignOut();
          }}

          className={cn(
            "profile-menu-action",
            "w-full h-8.5 [padding:0_14px] flex items-center gap-2.5 type-meta text-left text-destructive",
            signingOut ? "cursor-default" : "cursor-pointer",
            signingOut ? "[opacity:0.6]" : "[opacity:1]",
          )}
        >
          <ArrowLeftIcon size={16} />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
