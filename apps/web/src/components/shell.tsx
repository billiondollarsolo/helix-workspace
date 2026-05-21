import { Link, Outlet, useLocation } from "@tanstack/react-router";
import {
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Dna,
  Lightbulb,
  Monitor,
  Moon,
  Plus,
  Search,
  Sun,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { toggleRightRailOpen, useShellUiStore } from "@/components/shell-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { workspaceSummaryQueryOptions } from "@/features/workspace/queries";
import { coreAppsShellQueryOptions } from "@/features/admin/core-apps-api";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  useColorMode,
  usePlatformSnapshot,
  useWebPlatformHost,
  type ColorMode,
} from "@helix/sdk-web";

const knownShellRoutes = [
  "/mail",
  "/chat",
  "/drive",
  "/docs",
  "/calendar",
  "/meet",
  "/assistant",
  "/settings",
  "/admin",
] as const;

type KnownShellRoute = (typeof knownShellRoutes)[number];

function isKnownShellRoute(route: string): route is KnownShellRoute {
  return knownShellRoutes.includes(route as KnownShellRoute);
}

function HelixMark() {
  return (
    <Dna
      aria-hidden="true"
      className="size-6 shrink-0 text-sidebar-primary"
      strokeWidth={2.25}
    />
  );
}

export function AppShell() {
  const location = useLocation();
  const host = useWebPlatformHost();
  const actor = host.useActor();
  const colorMode = useColorMode();
  const allRailItems = usePlatformSnapshot((platformHost) => platformHost.getLeftRailItems());
  const rightPanels = usePlatformSnapshot((platformHost) =>
    platformHost.getRightRailPanels(location.pathname),
  );
  const { data } = useSuspenseQuery(workspaceSummaryQueryOptions());
  // Core-app enablement: the left rail shows only core apps that are enabled
  // org-wide AND served by this deployment. Non-core items (Settings, Admin)
  // are always shown. While the query is in flight we show everything to
  // avoid a flash of an empty rail.
  const coreAppsQuery = useQuery(coreAppsShellQueryOptions());
  const railItems = useMemo(() => {
    // Defensive: if the query is in flight, errored, or returned junk, treat it
    // as "no gating info" and show every rail item. `status?.apps ?? []`
    // guarantees `.filter` is never called on `undefined` even if the query
    // somehow resolves with a malformed payload.
    const apps = coreAppsQuery.data?.apps ?? [];
    if (apps.length === 0) {
      return allRailItems;
    }
    const unavailable = new Set<string>(
      apps.filter((app) => !app.registered).map((app) => app.id),
    );
    return allRailItems.filter((item) => !unavailable.has(item.id));
  }, [allRailItems, coreAppsQuery.data]);
  const [commandOpen, setCommandOpen] = useState(false);
  const rightRailOpen = useShellUiStore(
    (state) => state.rightRailOpenByRoute[location.pathname] ?? false,
  );
  const activeShellItem = useMemo(() => {
    const routePath = location.pathname.startsWith("/docs") ? "/drive" : location.pathname;
    return (
      railItems.find(
        (item) => routePath === item.route || routePath.startsWith(`${item.route}/`),
      ) ?? railItems[0]
    );
  }, [location.pathname, railItems]);
  const ActiveShellIcon = activeShellItem?.icon ?? Search;
  const activeShellLabel = activeShellItem?.label ?? "Helix";

  const initials = useMemo(
    () =>
      actor.displayName
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
    [actor.displayName],
  );

  const toggleTheme = useCallback(() => {
    colorMode.toggle();
  }, [colorMode]);

  useEffect(() => {
    document.addEventListener("helix:toggle-theme", toggleTheme);
    return () => document.removeEventListener("helix:toggle-theme", toggleTheme);
  }, [toggleTheme]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="relative w-16 shrink-0">
        <aside
          aria-label="Primary navigation"
          className="fixed inset-y-0 left-0 z-40 flex w-16 flex-col items-center gap-2 border-r border-sidebar-border bg-sidebar px-2 py-3 text-sidebar-foreground shadow-none"
        >
          <div className="grid min-h-10 place-items-center">
            <Link
              aria-label="Helix home"
              className="grid size-10 place-items-center rounded-full text-sidebar-foreground no-underline outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/30"
              search={{ message: undefined, thread: undefined }}
              title="Helix"
              to="/mail"
            >
              <HelixMark />
            </Link>
          </div>
          <nav aria-label="Workspace apps" className="flex min-w-0 flex-col items-center gap-1">
            {railItems.map((item) => {
              const Icon = item.icon;
              const route = isKnownShellRoute(item.route) ? item.route : "/settings";
              return (
                <Link
                  activeProps={{
                    "aria-current": "page",
                    "data-active": "true",
                  }}
                  aria-label={item.label}
                  className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] font-medium leading-none text-sidebar-foreground/75 no-underline outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/30 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
                  key={item.id}
                  title={item.label}
                  to={route}
                >
                  <Icon aria-hidden="true" className="size-[18px] shrink-0" />
                  <span className="max-w-full truncate px-0.5">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>
      </div>

      <div className="workspace-frame flex-1">
        <header className="top-bar">
          <div className="shell-brand flex w-44 shrink-0 items-center gap-3 overflow-hidden text-foreground max-[820px]:hidden">
            <span className="shell-brand-icon grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-accent text-sidebar-accent-foreground">
              <ActiveShellIcon aria-hidden="true" size={21} />
            </span>
            <strong className="truncate text-xl font-normal">{activeShellLabel}</strong>
          </div>
          <Button
            className="shell-search-trigger min-h-10 max-w-[760px] flex-1 justify-start gap-2.5 rounded-full border-outline-variant bg-surface-container-high px-4 text-sm font-normal text-muted-foreground hover:bg-accent"
            onClick={() => setCommandOpen(true)}
            type="button"
            variant="outline"
          >
            <Search aria-hidden="true" size={18} />
            <span>Search {activeShellLabel}</span>
            <kbd>⌘K</kbd>
          </Button>

          <div className="top-actions">
            <Button
              aria-label="Open help"
              className="icon-button size-10 rounded-full border-0 bg-transparent text-foreground"
              size="icon"
              type="button"
              variant="ghost"
            >
              <CircleHelp aria-hidden="true" size={18} />
            </Button>
            <Button
              aria-label="Open notifications"
              className="badge-button size-10 rounded-full border-0 bg-transparent text-foreground"
              size="icon"
              type="button"
              variant="ghost"
            >
              <Bell aria-hidden="true" size={18} />
              <span>{data.unreadNotifications}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Account: ${actor.displayName}`}
                  className="size-10 justify-center rounded-full border-0 bg-transparent p-0 hover:bg-[var(--md-sys-state-hover)]"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    {initials || <UserRound aria-hidden="true" size={16} />}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <span className="account-menu-label">{actor.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={colorMode.mode}
                  onValueChange={(value) => colorMode.setMode(value as ColorMode)}
                >
                  <DropdownMenuRadioItem value="light">
                    <Sun aria-hidden="true" size={16} />
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon aria-hidden="true" size={16} />
                    Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor aria-hidden="true" size={16} />
                    System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="content-frame">
          <div className="main-content">
            <Outlet />
          </div>
          {rightPanels.length > 0 ? (
            <aside
              className={rightRailOpen ? "right-rail open" : "right-rail"}
              aria-label="Context panel"
            >
              <Button
                aria-expanded={rightRailOpen}
                aria-label={rightRailOpen ? "Collapse right rail" : "Expand right rail"}
                className="right-rail-toggle rounded-full border-outline-variant bg-surface-container hover:bg-accent"
                onClick={() => toggleRightRailOpen(location.pathname)}
                size="icon"
                type="button"
                variant="outline"
              >
                {rightRailOpen ? (
                  <ChevronRight aria-hidden="true" size={20} />
                ) : (
                  <ChevronLeft aria-hidden="true" size={20} />
                )}
              </Button>
              {rightRailOpen ? rightPanels[0]?.render() : null}
            </aside>
          ) : null}
          <aside className="google-side-rail" aria-label="Google workspace shortcuts">
            <button
              aria-label={rightRailOpen ? "Close side panel" : "Open side panel"}
              className={rightRailOpen ? "google-side-rail-button active" : "google-side-rail-button"}
              onClick={() => toggleRightRailOpen(location.pathname)}
              type="button"
            >
              <CalendarDays aria-hidden="true" size={20} />
            </button>
            <button aria-label="Open Keep" className="google-side-rail-button" type="button">
              <Lightbulb aria-hidden="true" size={20} />
            </button>
            <button aria-label="Open Tasks" className="google-side-rail-button" type="button">
              <CheckCircle2 aria-hidden="true" size={20} />
            </button>
            <button aria-label="Open Contacts" className="google-side-rail-button" type="button">
              <UserRound aria-hidden="true" size={20} />
            </button>
            <span className="google-side-rail-separator" aria-hidden="true" />
            <button aria-label="Add workspace shortcut" className="google-side-rail-button" type="button">
              <Plus aria-hidden="true" size={21} />
            </button>
          </aside>
        </div>
      </div>

      <CommandPalette open={commandOpen} setOpen={setCommandOpen} />
    </div>
  );
}
