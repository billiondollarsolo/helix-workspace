/* In-call side panels: participants, host controls, call options and
   in-call messages share one 320px panel frame. */

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { MessageCircle as ChatIcon, Settings as SettingsIcon, X as XIcon } from "lucide-react";
import { useState } from "react";
import type { MeetCallCommands, MeetCallState, MeetChatMessage } from "./meet-call-controls";

export function CallOptionsPanel({
  call,
  commands,
  onClose,
}: {
  readonly call: MeetCallState;
  readonly commands: MeetCallCommands;
  readonly onClose: () => void;
}) {
  return (
    <SidePanel title="Call options" icon={<SettingsIcon size={16} />} onClose={onClose}>
      <div className="p-3 grid gap-2">
        {call.capabilities.tileView ? (
          <PolicyButton
            label={call.tileView ? "Use speaker layout" : "Use tile layout"}
            onClick={commands.toggleTileView}
          />
        ) : null}
        {call.capabilities.noiseSuppression ? (
          <PolicyButton
            label={
              call.noiseSuppressionEnabled === true
                ? "Disable noise suppression"
                : "Enable noise suppression"
            }
            onClick={() => {
              commands.setNoiseSuppression(call.noiseSuppressionEnabled !== true);
            }}
          />
        ) : null}
      </div>
    </SidePanel>
  );
}

export function SidePanel({
  title,
  icon,
  children,
  onClose,
  ariaLabel,
}: {
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
  readonly onClose: () => void;
  readonly ariaLabel?: string;
}) {
  return (
    <div
      aria-label={ariaLabel ?? title}
      className="w-80 flex flex-col bg-[var(--surface)] [border-left:1px_solid_var(--border)]"
    >
      <div className="[padding:12px_16px] flex items-center gap-2 [border-bottom:1px_solid_var(--border)]">
        {icon}
        <span className="font-semibold type-body-sm">{title}</span>
        <button
          className="icon-btn ml-auto"
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

export function ParticipantRow({
  name,
  badge,
  children,
}: {
  readonly name: string;
  readonly badge?: string | null;
  readonly children?: React.ReactNode;
}) {
  return (
    <li className="[padding:10px_16px] flex items-center gap-2.5 [border-bottom:1px_solid_var(--border)]">
      <Avatar name={name} size={28} />
      <span className="flex-1 type-body-sm">{name}</span>
      {badge !== undefined && badge !== null ? (
        <span className="type-caption [color:var(--danger)]">{badge}</span>
      ) : null}
      {children}
    </li>
  );
}

export function MiniAction({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="btn sm" onClick={onClick} aria-label={label}>
      {label}
    </button>
  );
}

export function PolicyButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="btn" onClick={onClick}>
      {label}
    </button>
  );
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function ChatPanel({
  messages,
  onSend,
  onClose,
}: {
  readonly messages: readonly MeetChatMessage[];
  readonly onSend: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <SidePanel title="In-call messages" icon={<ChatIcon size={16} />} onClose={onClose}>
      <div className="p-3 flex flex-col gap-2">
        {messages.length === 0 ? (
          <p className="m-0 [color:var(--text-3)] type-meta text-center [padding:24px_0]">
            No messages yet. Say hi.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "flex flex-col gap-0.5 [max-width:85%]",
                m.isLocal ? "[align-self:flex-end]" : "[align-self:flex-start]",
              )}
            >
              <span
                className={cn(
                  "type-caption [color:var(--text-3)]",
                  m.isLocal ? "text-right" : "text-left",
                )}
              >
                {m.nick}
              </span>
              <span
                className={cn(
                  "[padding:6px_10px] [border-radius:10px] type-body-sm whitespace-pre-wrap [word-break:break-word]",
                  m.isLocal
                    ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "bg-[var(--surface-3)] text-[var(--text)]",
                )}
              >
                {m.message}
              </span>
            </div>
          ))
        )}
      </div>
      <form
        className="p-2.5 flex gap-1.5 [border-top:1px_solid_var(--border)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim().length === 0) return;
          onSend(draft);
          setDraft("");
        }}
      >
        <input
          aria-label="Message everyone in the call"
          placeholder="Message everyone in the call"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          className="focus-ring flex-1 h-7.5 [padding:0_10px] rounded-md bg-[var(--bg)] text-[var(--text)] type-meta [border:1px_solid_var(--border)]"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={draft.trim().length === 0}
          className={cn(
            "h-7.5 [padding:0_10px] rounded-md [border:none] bg-[var(--accent)] text-[var(--accent-fg)] cursor-pointer",
            draft.trim().length === 0 ? "[opacity:0.5]" : "[opacity:1]",
          )}
        >
          Send
        </button>
      </form>
    </SidePanel>
  );
}
