/* Right side panel — the 44px tool rail + 320px mini panels.
   Ported from the design handoff (side-panel.jsx). Tools: Calendar, Tasks,
   Notes, Contacts, Helix AI. Panels default to closed; the user opens one
   explicitly from the rail. */

import { useState, type ReactNode } from "react";
import { Icons, type IconName } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { PEOPLE } from "@/components/people";

export type SideTool = "calendar" | "tasks" | "notes" | "contacts" | "ai";

interface SideToolDef {
  id: SideTool;
  label: string;
  icon: IconName;
}

const SIDE_TOOLS: readonly SideToolDef[] = [
  { id: "calendar", label: "Calendar", icon: "Calendar" },
  { id: "tasks", label: "Tasks", icon: "Check" },
  { id: "notes", label: "Notes", icon: "EditPen" },
  { id: "contacts", label: "Contacts", icon: "Users" },
  { id: "ai", label: "Helix AI", icon: "Sparkles" },
];

const sectionLabelStyle = {
  fontSize: 10,
  color: "var(--text-3)",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: ".06em",
  marginBottom: 8,
};

/* ---------- Mini Calendar ---------- */

function MiniCalendar() {
  const todayEvents = [
    { time: "9:30", end: "10:30", title: "1:1 with Jonas", color: "#475569" },
    { time: "11:00", end: "12:00", title: "Hiring loop debrief", color: "#059669" },
    { time: "14:00", end: "15:00", title: "Caroline Reyes / Atlas", color: "#0891b2" },
    { time: "15:30", end: "17:00", title: "Postmortem — auth", color: "#dc2626" },
  ];
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "12px 14px 6px" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>May 2026</span>
          <div style={{ marginLeft: "auto", display: "flex" }}>
            <button type="button" className="icon-btn" aria-label="Previous month">
              <Icons.ChevronLeft />
            </button>
            <button type="button" className="icon-btn" aria-label="Next month">
              <Icons.ChevronRight />
            </button>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 1,
            fontSize: 10,
            textAlign: "center",
            color: "var(--text-3)",
            marginBottom: 4,
          }}
        >
          {days.map((day, index) => (
            <div key={`${day}-${index}`}>{day}</div>
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 1,
            fontSize: 11,
            textAlign: "center",
          }}
        >
          {Array.from({ length: 35 }).map((_, index) => {
            const day = index - 3;
            const valid = day >= 1 && day <= 31;
            const today = day === 21;
            return (
              <div
                key={index}
                style={{
                  aspectRatio: "1",
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 999,
                  color: !valid ? "var(--text-3)" : today ? "white" : "var(--text)",
                  background: today ? "var(--accent)" : "transparent",
                  fontWeight: today ? 600 : 400,
                  cursor: valid ? "pointer" : "default",
                }}
              >
                {valid ? day : ""}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ height: 1, background: "var(--border)", margin: "8px 0" }} />
      <div style={{ padding: "0 14px 12px", flex: 1, overflowY: "auto" }}>
        <div style={sectionLabelStyle}>Today · Thu, May 21</div>
        {todayEvents.map((event, index) => (
          <div
            key={event.title}
            style={{
              display: "flex",
              gap: 10,
              padding: "6px 0",
              fontSize: 12,
              borderTop: index ? "1px solid var(--border)" : "none",
            }}
          >
            <div
              style={{
                width: 3,
                alignSelf: "stretch",
                background: event.color,
                borderRadius: 2,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }} className="truncate">
                {event.title}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {event.time} – {event.end}
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="btn sm" style={{ width: "100%", marginTop: 12 }}>
          <Icons.Plus /> New event
        </button>
      </div>
    </div>
  );
}

/* ---------- Mini Tasks ---------- */

interface MiniTask {
  id: number;
  text: string;
  done: boolean;
  list: "Today" | "This week";
}

function MiniTasks() {
  const [tasks, setTasks] = useState<MiniTask[]>([
    { id: 1, text: "Review Q3 roadmap doc", done: false, list: "Today" },
    { id: 2, text: "Reply to Atlas — early renewal", done: false, list: "Today" },
    { id: 3, text: "Approve hiring plan", done: true, list: "Today" },
    { id: 4, text: "Sign DPA template", done: false, list: "This week" },
    { id: 5, text: "1:1 prep for Friday", done: false, list: "This week" },
    { id: 6, text: "Read postmortem", done: true, list: "This week" },
  ]);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");

  const toggle = (id: number) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const add = () => {
    if (!newText.trim()) {
      setAdding(false);
      return;
    }
    setTasks((prev) => [
      ...prev,
      { id: Date.now(), text: newText, done: false, list: "Today" },
    ]);
    setNewText("");
    setAdding(false);
  };

  const groups: MiniTask["list"][] = ["Today", "This week"];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border)" }}>
        <button
          type="button"
          className="btn primary sm"
          style={{ width: "100%" }}
          onClick={() => setAdding(true)}
        >
          <Icons.Plus /> Add task
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px 12px" }}>
        {adding ? (
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input
              autoFocus
              className="input"
              placeholder="New task…"
              value={newText}
              onChange={(event) => setNewText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  add();
                }
                if (event.key === "Escape") {
                  setAdding(false);
                  setNewText("");
                }
              }}
              onBlur={add}
            />
          </div>
        ) : null}
        {groups.map((group) => (
          <div key={group} style={{ marginBottom: 16 }}>
            <div style={sectionLabelStyle}>{group}</div>
            {tasks
              .filter((task) => task.list === group)
              .map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => toggle(task.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 4px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    width: "100%",
                    textAlign: "left",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = "var(--hover)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      border: `1.5px solid ${task.done ? "var(--accent)" : "var(--border-2)"}`,
                      background: task.done ? "var(--accent)" : "transparent",
                      display: "grid",
                      placeItems: "center",
                      color: "white",
                      flexShrink: 0,
                      transition: "all 0.1s",
                    }}
                  >
                    {task.done ? <Icons.Check size={11} /> : null}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      textDecoration: task.done ? "line-through" : "none",
                      color: task.done ? "var(--text-3)" : "var(--text)",
                    }}
                  >
                    {task.text}
                  </span>
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Mini Notes ---------- */

interface MiniNote {
  id: number;
  title: string;
  body: string;
}

function MiniNotes() {
  const [notes, setNotes] = useState<MiniNote[]>([
    {
      id: 1,
      title: "Atlas renewal — talking points",
      body: "Lock current pricing thru 2027. Push for migration window in early Q4. Offer Caroline an exec sync.",
    },
    {
      id: 2,
      title: "Q3 prep",
      body: "Three open items: Atlas timing, hiring, pricing tier. Want sign-off Friday.",
    },
  ]);
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border)" }}>
        <button
          type="button"
          className="btn primary sm"
          style={{ width: "100%" }}
          onClick={() => {
            const note: MiniNote = { id: Date.now(), title: "New note", body: "" };
            setNotes((prev) => [note, ...prev]);
            setEditing(note.id);
          }}
        >
          <Icons.Plus /> New note
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {notes.map((note) => (
          <div
            key={note.id}
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 10,
              marginBottom: 8,
            }}
          >
            {editing === note.id ? (
              <>
                <input
                  autoFocus
                  className="input"
                  value={note.title}
                  onChange={(event) =>
                    setNotes((prev) =>
                      prev.map((n) =>
                        n.id === note.id ? { ...n, title: event.target.value } : n,
                      ),
                    )
                  }
                  style={{ marginBottom: 6, fontWeight: 600 }}
                />
                <textarea
                  className="input"
                  value={note.body}
                  rows={4}
                  onChange={(event) =>
                    setNotes((prev) =>
                      prev.map((n) =>
                        n.id === note.id ? { ...n, body: event.target.value } : n,
                      ),
                    )
                  }
                  onBlur={() => setEditing(null)}
                  style={{
                    height: "auto",
                    padding: 8,
                    resize: "vertical",
                    fontFamily: "inherit",
                  }}
                />
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(note.id)}
                style={{
                  cursor: "text",
                  textAlign: "left",
                  width: "100%",
                  background: "none",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                  {note.title}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.5 }}>
                  {note.body || <span style={{ color: "var(--text-3)" }}>Empty note</span>}
                </div>
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Mini Contacts ---------- */

function MiniContacts() {
  return (
    <div style={{ padding: 12, overflowY: "auto", height: "100%" }}>
      <input
        className="input"
        placeholder="Search contacts…"
        style={{ marginBottom: 12 }}
        aria-label="Search contacts"
      />
      <div style={sectionLabelStyle}>Frequent</div>
      {PEOPLE.slice(0, 8).map((person) => (
        <div
          key={person.email}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 4px",
            borderRadius: 4,
            fontSize: 12,
            cursor: "pointer",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = "var(--hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "transparent";
          }}
        >
          <Avatar name={person.name} size={28} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 500 }} className="truncate">
              {person.name}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }} className="truncate">
              {person.role}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Mini Helix AI ---------- */

function MiniAI() {
  const suggestions = [
    "Summarize my unread inbox",
    "Draft replies to flagged threads",
    "What did I miss while away?",
    "Find time with Mira this week",
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
            fontSize: 13,
            marginBottom: 4,
          }}
        >
          <Icons.Sparkles />
          Helix AI
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>
          Your assistant for mail, docs, and the rest of the workspace.
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        <div style={sectionLabelStyle}>Suggested</div>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            style={{
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              marginBottom: 4,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text)",
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            height: 34,
          }}
        >
          <Icons.Sparkles />
          <input
            placeholder="Ask Helix AI…"
            aria-label="Ask Helix AI"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 12,
            }}
          />
          <button type="button" className="icon-btn" aria-label="Send">
            <Icons.Send />
          </button>
        </div>
      </div>
    </div>
  );
}

interface MiniView {
  title: string;
  icon: IconName;
  Component: () => ReactNode;
}

const MINI_VIEWS: Record<SideTool, MiniView> = {
  calendar: { title: "Calendar", icon: "Calendar", Component: MiniCalendar },
  tasks: { title: "Tasks", icon: "Check", Component: MiniTasks },
  notes: { title: "Notes", icon: "EditPen", Component: MiniNotes },
  contacts: { title: "Contacts", icon: "Users", Component: MiniContacts },
  ai: { title: "Helix AI", icon: "Sparkles", Component: MiniAI },
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
            onClick={() => onToggle(tool.id)}
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
      <button
        type="button"
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          color: "var(--text-3)",
        }}
        title="Add app"
        aria-label="Add app"
      >
        <Icons.Plus />
      </button>
    </div>
  );
}

export interface SidePanelProps {
  activeTool: SideTool | null;
  onClose: () => void;
}

export function SidePanel({ activeTool, onClose }: SidePanelProps) {
  if (!activeTool) {
    return null;
  }
  const view = MINI_VIEWS[activeTool];
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
        <span style={{ fontWeight: 600, fontSize: 13 }}>{view.title}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <button type="button" className="icon-btn" title="Open full" aria-label="Open full">
            <Icons.Grid />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close panel"
          >
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
