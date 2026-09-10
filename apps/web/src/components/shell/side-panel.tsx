import { cn } from "@/lib/utils";
import { iconMap as Icons, type IconName } from "@/components/icon-map";
import {
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Grid2X2 as GridIcon,
  Plus as PlusIcon,
  Sparkles as SparklesIcon,
  X as XIcon,
} from "lucide-react";
/* Right side panel — the 44px tool rail + 320px mini panels. */
import { peopleDirectoryQueryOptions } from "@/features/people/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState, type ReactNode } from "react";
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
          <span className="[font-size:var(--text-body-sm)] font-semibold">{monthLabel}</span>
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
        <div className="grid [grid-template-columns:repeat(7,_1fr)] [gap:1px] [font-size:var(--text-chip)] text-center text-muted-foreground mb-1">
          {days.map((day, index) => (
            <div key={`${day}-${String(index)}`}>{day}</div>
          ))}
        </div>
        <div className="grid [grid-template-columns:repeat(7,_1fr)] [gap:1px] [font-size:var(--text-caption)] text-center">
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
        <div className="[font-size:var(--text-chip)] text-muted-foreground font-semibold uppercase [letter-spacing:.06em] mb-2">
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
/* ---------- Mini Contacts ---------- */
function MiniContacts() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const people = useQuery(peopleDirectoryQueryOptions({ query: deferredQuery, limit: 50 }));
  return (
    <div className="p-3 overflow-y-auto h-full">
      <input
        className="input mb-3"
        placeholder="Search contacts…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}

        aria-label="Search contacts"
      />
      {people.isLoading ? <div role="status">Loading contacts…</div> : null}
      {people.isError ? (
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ["people", "directory"] });
          }}
        >
          Retry contacts
        </button>
      ) : null}
      {people.data?.length === 0 ? <div>No matching contacts.</div> : null}
      {people.data?.map((person) => (
        <a
          key={person.id}
          href={person.email === null ? undefined : `mailto:${person.email}`}
          aria-disabled={person.email === null}
          className="flex gap-2 items-center [padding:8px_4px]"
        >
          {person.avatarDataUrl === null ? null : (
            <img
              src={person.avatarDataUrl}
              alt=""
              width={28}
              height={28}
              className="rounded-full"
            />
          )}
          <span>
            <strong>{person.favorite ? `★ ${person.displayName}` : person.displayName}</strong>
            {person.email === null ? null : <span className="block">{person.email}</span>}
            <span className="block text-muted-foreground [font-size:var(--text-caption)]">
              {person.kind}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
/* ---------- Mini Helix AI ---------- */
function MiniAI() {
  const navigate = useNavigate();
  const suggestions = [
    "Summarize my unread inbox",
    "Draft replies to flagged threads",
    "What did I miss while away?",
    "Find time on my calendar this week",
  ];
  return (
    <div className="flex flex-col h-full">
      <div className="p-3.5 [border-bottom:1px_solid_var(--border)]">
        <div className="flex items-center gap-2 text-primary font-semibold [font-size:var(--text-body-sm)] mb-1">
          <SparklesIcon size={16} />
          Helix AI
        </div>
        <div className="[font-size:var(--text-caption)] text-muted-foreground">
          Your assistant for mail, files, and the rest of the workspace.
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="[font-size:var(--text-chip)] text-muted-foreground font-semibold uppercase [letter-spacing:.06em] mb-2">
          Suggested
        </div>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => void navigate({ to: "/assistant" })}
            className="w-full text-left [padding:8px_10px] mb-1 bg-muted [border:1px_solid_var(--border)] rounded-md [font-size:var(--text-meta)] text-foreground"
          >
            {suggestion}
          </button>
        ))}
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
  contacts: { title: "Contacts", icon: "Users", Component: MiniContacts },
  ai: { title: "Helix AI", icon: "Sparkles", Component: MiniAI, fullRoute: "/assistant" },
};
/* ---------- Rail + Panel ---------- */
export interface SidePanelRailProps {
  activeTool: SideTool | null;
  onToggle: (tool: SideTool) => void;
}
export function SidePanelRail({ activeTool, onToggle }: SidePanelRailProps) {
  return (
    <div className="w-11 shrink-0 [border-left:1px_solid_var(--border)] bg-card flex flex-col items-center [padding:8px_0] gap-0.5">
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
            className={cn(
              "w-8 h-8 rounded-md grid [place-items:center] relative",
              active ? "[background:var(--accent-soft)]" : "bg-transparent",
              active ? "text-primary" : "[color:var(--text-2)]",
            )}
            onMouseEnter={(event) => {
              if (!active) {
                event.currentTarget.style.background = "var(--hover)";
              }
            }}
            onMouseLeave={(event) => {
              if (!active) {
                event.currentTarget.style.background = "transparent";
              }
            }}
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
        <span className="font-semibold [font-size:var(--text-body-sm)]">{view.title}</span>
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
