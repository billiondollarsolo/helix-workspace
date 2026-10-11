import { cn } from "@/lib/utils";
import { iconMap as Icons, type IconName } from "@/components/icon-map";
import {
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Grid2X2 as GridIcon,
  Plus as PlusIcon,
  X as XIcon,
} from "lucide-react";
/* Right side panel — the 44px tool rail + 320px mini panels. */
import { ContactsPanel } from "@/components/people/contacts-panel";
import { AssistantSidePanel } from "@/features/assistant/assistant-side-panel";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
export type SideTool = "calendar" | "contacts" | "ai";
interface SideToolDef {
  id: SideTool;
  label: string;
  icon: IconName;
}
const SIDE_TOOLS: readonly SideToolDef[] = [
  { id: "calendar", label: "Calendar", icon: "Calendar" },
  { id: "contacts", label: "Contacts", icon: "Users" },
  { id: "ai", label: "Helix AI", icon: "Sparkles" },
];
/* ---------- Mini Calendar ---------- */
function MiniCalendar() {
  const navigate = useNavigate();
  const todayDate = new Date();
  const [month, setMonth] = useState(
    () => new Date(todayDate.getFullYear(), todayDate.getMonth(), 1),
  );
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayLabel = todayDate.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  // Render the current month grid (Sunday-first). First-of-month offset
  // determines how many leading blanks the grid needs.
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const leadingBlanks = firstOfMonth.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = todayDate.getDate();
  const isCurrentMonth =
    month.getFullYear() === todayDate.getFullYear() && month.getMonth() === todayDate.getMonth();
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div className="flex flex-col h-full">
      <div className="[padding:12px_14px_6px]">
        <div className="flex items-center mb-2">
          <span className="type-body-sm font-semibold">{monthLabel}</span>
          <div className="ml-auto flex">
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous month"
              onClick={() => {
                setMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1));
              }}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Next month"
              onClick={() => {
                setMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1));
              }}
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>
        </div>
        <div className="grid [grid-template-columns:repeat(7,_1fr)] [gap:1px] type-chip text-center text-muted-foreground mb-1">
          {days.map((day, index) => (
            <div key={`${day}-${String(index)}`}>{day}</div>
          ))}
        </div>
        <div className="grid [grid-template-columns:repeat(7,_1fr)] [gap:1px] type-caption text-center">
          {Array.from({ length: 42 }).map((_, index) => {
            const day = index - leadingBlanks + 1;
            const valid = day >= 1 && day <= daysInMonth;
            const isToday = isCurrentMonth && valid && day === today;
            return (
              <button
                type="button"
                key={index}
                disabled={!valid}
                aria-label={
                  valid
                    ? new Date(month.getFullYear(), month.getMonth(), day).toLocaleDateString()
                    : undefined
                }
                onClick={() => void navigate({ to: "/calendar" })}
                className={cn(
                  "[aspect-ratio:1] grid [place-items:center] [border-radius:999px]",
                  !valid ? "text-muted-foreground" : isToday ? "[color:white]" : "text-foreground",
                  isToday ? "[background:var(--accent)]" : "bg-transparent",
                  isToday ? "font-semibold" : "font-normal",
                  valid ? "cursor-pointer" : "cursor-default",
                )}
              >
                {valid ? day : ""}
              </button>
            );
          })}
        </div>
      </div>
      <div className="[height:1px] [background:var(--border)] [margin:8px_0]" />
      <div className="[padding:0_14px_12px] flex-1 overflow-y-auto">
        <div className="type-chip text-muted-foreground font-semibold uppercase [letter-spacing:.06em] mb-2">
          Today · {todayLabel}
        </div>
        <button
          type="button"
          className="btn sm w-full mt-3"

          onClick={() => void navigate({ to: "/calendar" })}
        >
          <PlusIcon size={16} /> New event
        </button>
      </div>
    </div>
  );
}
interface MiniView {
  title: string;
  icon: IconName;
  Component: () => ReactNode;
  fullRoute?: "/calendar" | "/assistant";
}
const MINI_VIEWS: Record<SideTool, MiniView> = {
  calendar: {
    title: "Calendar",
    icon: "Calendar",
    Component: MiniCalendar,
    fullRoute: "/calendar",
  },
  contacts: { title: "Contacts", icon: "Users", Component: ContactsPanel },
  ai: {
    title: "Helix AI",
    icon: "Sparkles",
    Component: AssistantSidePanel,
    fullRoute: "/assistant",
  },
};
/* ---------- Rail + Panel ---------- */
export interface SidePanelRailProps {
  activeTool: SideTool | null;
  onToggle: (tool: SideTool) => void;
}
export function SidePanelRail({ activeTool, onToggle }: SidePanelRailProps) {
  return (
    <div className="side-panel-rail">
      {SIDE_TOOLS.map((tool) => {
        const Icon = Icons[tool.icon];
        const active = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            onClick={() => {
              onToggle(tool.id);
            }}
            aria-label={tool.label}
            aria-pressed={active}
            title={tool.label}
            className="side-panel-rail-button"
          >
            <Icon size={16} />
          </button>
        );
      })}
      <div className="flex-1" />
    </div>
  );
}
export interface SidePanelProps {
  activeTool: SideTool | null;
  onClose: () => void;
}
export function SidePanel({ activeTool, onClose }: SidePanelProps) {
  const navigate = useNavigate();
  if (!activeTool) {
    return null;
  }
  const view = MINI_VIEWS[activeTool];
  const fullRoute = view.fullRoute;
  const Icon = Icons[view.icon];
  const { Component } = view;
  return (
    <div className="w-80 shrink-0 [border-left:1px_solid_var(--border)] bg-card flex flex-col min-h-0">
      <div className="h-10 flex items-center [padding:0_14px] gap-2 [border-bottom:1px_solid_var(--border)] shrink-0">
        <Icon size={16} />
        <span className="font-semibold type-body-sm">{view.title}</span>
        <div className="ml-auto flex gap-0.5">
          {fullRoute === undefined ? null : (
            <button
              type="button"
              className="icon-btn"
              title="Open full"
              aria-label="Open full"
              onClick={() => void navigate({ to: fullRoute })}
            >
              <GridIcon size={16} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel">
            <XIcon size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">
        <Component />
      </div>
    </div>
  );
}
