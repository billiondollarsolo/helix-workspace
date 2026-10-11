/* Renders every open compose window, docked bottom-right with the newest on
   the left, and opens one for `/mail?compose=new&to=…` links (person
   hovercards, the command palette). Mount once in the Mail surface. */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { mailComposeHandoffFromSearch } from "@/features/people/handoff";
import { openCompose, useComposeWindows } from "./compose-store";
import { ComposeWindow } from "./compose-window";
import "./compose.css";

function useComposeHandoff() {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const navigate = useNavigate();
  const handoff = mailComposeHandoffFromSearch(search);
  const handled = useRef<string | null>(null);
  const key = handoff.compose === undefined ? null : `${handoff.compose}:${handoff.to ?? ""}`;

  useEffect(() => {
    if (key === null) {
      handled.current = null;
      return;
    }
    if (handled.current === key) return;
    handled.current = key;
    openCompose(handoff.to === undefined ? {} : { to: handoff.to });
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(previous).filter(([name]) => name !== "compose" && name !== "to"),
        ),
      replace: true,
    });
  }, [handoff.to, key, navigate]);
}

export function ComposeHost() {
  const windows = useComposeWindows();
  useComposeHandoff();
  if (windows.length === 0) return null;
  return (
    <div className="compose-dock">
      {windows.map((state) => (
        <ComposeWindow key={state.id} state={state} />
      ))}
    </div>
  );
}
