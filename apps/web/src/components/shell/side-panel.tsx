/* Right side panel — the 44px tool rail + 320px mini panels. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState, type ReactNode } from "react";
import { Icons, type IconName } from "@/components/icons";
import { peopleDirectoryQueryOptions } from "@/features/people/api";

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

const sectionLabelStyle = {
  fontSize: "var(--text-chip)",
  color: "var(--text-3)",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: ".06em",
  marginBottom: 8,
};

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "12px 14px 6px" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: "var(--text-body-sm)", fontWeight: 600 }}>{monthLabel}</span>
          <div style={{ marginLeft: "auto", display: "flex" }}>
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous month"
              onClick={() => {
                setMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1));
              }}
            >
              <Icons.ChevronLeft />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Next month"
              onClick={() => {
                setMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1));
              }}
            >
              <Icons.ChevronRight />
            </button>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 1,
            fontSize: "var(--text-chip)",
            textAlign: "center",
            color: "var(--text-3)",
            marginBottom: 4,
          }}
        >
          {days.map((day, index) => (
            <div key={`${day}-${String(index)}`}>{day}</div>
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 1,
            fontSize: "var(--text-caption)",
            textAlign: "center",
          }}
        >
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
                style={{
                  aspectRatio: "1",
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 999,
                  color: !valid ? "var(--text-3)" : isToday ? "white" : "var(--text)",
                  background: isToday ? "var(--accent)" : "transparent",
                  fontWeight: isToday ? 600 : 400,
                  cursor: valid ? "pointer" : "default",
                }}
              >
                {valid ? day : ""}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ height: 1, background: "var(--border)", margin: "8px 0" }} />
      <div style={{ padding: "0 14px 12px", flex: 1, overflowY: "auto" }}>
        <div style={sectionLabelStyle}>Today · {todayLabel}</div>
        <button
          type="button"
          className="btn sm"
          style={{ width: "100%", marginTop: 12 }}
          onClick={() => void navigate({ to: "/calendar" })}
        >
          <Icons.Plus /> New event
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
    <div style={{ padding: 12, overflowY: "auto", height: "100%" }}>
      <input
        className="input"
        placeholder="Search contacts…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        style={{ marginBottom: 12 }}
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
          style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 4px" }}
        >
          {person.avatarDataUrl === null ? null : (
            <img src={person.avatarDataUrl} alt="" width={28} height={28} style={{ borderRadius: "50%" }} />
          )}
          <span>
            <strong>{person.favorite ? `★ ${person.displayName}` : person.displayName}</strong>
            {person.email === null ? null : <span style={{ display: "block" }}>{person.email}</span>}
            <span style={{ display: "block", color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--accent)",
            fontWeight: 600,
            fontSize: "var(--text-body-sm)",
            marginBottom: 4,
          }}
        >
          <Icons.Sparkles />
          Helix AI
        </div>
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
          Your assistant for mail, docs, and the rest of the workspace.
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        <div style={sectionLabelStyle}>Suggested</div>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => void navigate({ to: "/assistant" })}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              marginBottom: 4,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: "var(--text-meta)",
              color: "var(--text)",
            }}
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
    <div
      style={{
        width: 44,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "8px 0",
        gap: 2,
      }}
    >
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
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              display: "grid",
              placeItems: "center",
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--accent)" : "var(--text-2)",
              position: "relative",
            }}
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
            <Icon />
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
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
    <div
      style={{
        width: 320,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 8,
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <Icon />
        <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>{view.title}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          {fullRoute === undefined ? null : (
            <button
              type="button"
              className="icon-btn"
              title="Open full"
              aria-label="Open full"
              onClick={() => void navigate({ to: fullRoute })}
            >
              <Icons.Grid />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel">
            <Icons.X />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
        <Component />
      </div>
    </div>
  );
}
