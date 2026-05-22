/* Docs Share dialog — 480px modal with a people+role list and a General
   access panel. Ported from the design handoff (app-docs.jsx → ShareDialog). */

import { useState } from "react";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  GENERAL_ACCESS_OPTIONS,
  SHARE_PEOPLE,
  type GeneralAccess,
  type ShareRole,
} from "./data";

const ROLE_OPTIONS: readonly ShareRole[] = ["Owner", "Editor", "Commenter", "Viewer"];

export interface ShareDialogProps {
  /** Title of the document being shared. */
  readonly documentTitle: string;
  /** Document id — used to build the shareable link. */
  readonly documentId?: string;
  /** Called on Escape, backdrop click, "Done", or close affordance. */
  readonly onClose: () => void;
}

/** Builds an absolute, shareable link for a document. */
function shareLinkFor(documentId: string | undefined): string {
  if (typeof window === "undefined") {
    return documentId === undefined ? "/docs" : `/docs/${documentId}`;
  }
  return new URL(
    documentId === undefined ? "/docs" : `/docs/${encodeURIComponent(documentId)}`,
    window.location.origin,
  ).toString();
}

export function ShareDialog({ documentTitle, documentId, onClose }: ShareDialogProps) {
  const [access, setAccess] = useState<GeneralAccess>("restricted");
  const [copied, setCopied] = useState(false);
  const [roles, setRoles] = useState<Readonly<Record<string, ShareRole>>>(() =>
    Object.fromEntries(SHARE_PEOPLE.map((person) => [person.email, person.role])),
  );

  // Clears the "Link copied" confirmation a couple seconds after a copy.
  const resetCopied = useDebouncedCallback(() => setCopied(false), { wait: 2000 });

  function copyLink() {
    const link = shareLinkFor(documentId);
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard !== undefined) {
      void clipboard.writeText(link).then(() => {
        setCopied(true);
        resetCopied();
      });
    }
  }

  const activeOption =
    GENERAL_ACCESS_OPTIONS.find((option) => option.id === access) ??
    GENERAL_ACCESS_OPTIONS[0]!;

  return (
    <Dialog
      title={`Share "${documentTitle}"`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={copyLink}>
            <Icons.Link /> {copied ? "Link copied" : "Copy link"}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" type="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <input
          className="input"
          placeholder="Add people, groups, or emails"
          aria-label="Add people, groups, or emails"
          style={{ flex: 1 }}
        />
        <select className="select" aria-label="Role for new people" defaultValue="Editor">
          {ROLE_OPTIONS.filter((role) => role !== "Owner").map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>

      <div className="section-label" style={{ padding: "0 0 6px" }}>
        People with access
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {SHARE_PEOPLE.map((person) => (
          <li
            key={person.email}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}
          >
            <Avatar name={person.name} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500 }}>
                {person.name}
                {person.you ? (
                  <span style={{ color: "var(--text-3)", fontWeight: 400 }}> (you)</span>
                ) : null}
              </div>
              <div className="truncate" style={{ fontSize: 11, color: "var(--text-3)" }}>
                {person.email}
              </div>
            </div>
            {person.role === "Owner" ? (
              <span style={{ fontSize: 12, color: "var(--text-3)", paddingRight: 8 }}>Owner</span>
            ) : (
              <select
                className="select"
                aria-label={`Role for ${person.name}`}
                value={roles[person.email] ?? person.role}
                onChange={(event) =>
                  setRoles((current) => ({
                    ...current,
                    [person.email]: event.target.value as ShareRole,
                  }))
                }
                style={{ height: 26, fontSize: 12 }}
              >
                {ROLE_OPTIONS.filter((role) => role !== "Owner").map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>

      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: "var(--surface-2)",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 500, marginBottom: 8 }}>General access</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            {access === "restricted" ? <Icons.Lock /> : <Icons.Globe />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <select
              className="select"
              aria-label="General access"
              value={access}
              onChange={(event) => setAccess(event.target.value as GeneralAccess)}
              style={{ width: "100%" }}
            >
              {GENERAL_ACCESS_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>
              {activeOption.hint}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
