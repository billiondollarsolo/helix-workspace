import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { Hash as HashIcon, Plus as PlusIcon, Users as UsersIcon } from "lucide-react";
import { useState } from "react";

/* ----------------------------------------------------------------
   Spaces sidebar — 240px
   ---------------------------------------------------------------- */

interface SidebarRowSpace {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  readonly unread: number;
}

interface SidebarRowDirect {
  readonly id: string;
  readonly name: string;
  readonly presence: "active" | "offline";
  readonly unread: number;
}

interface ChatSidebarProps {
  readonly loading: boolean;
  readonly offline: boolean;
  readonly spaces: readonly SidebarRowSpace[];
  readonly directs: readonly SidebarRowDirect[];
  readonly activeRoomId: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onCreateRoom: (input: {
    readonly kind: "chat_room" | "chat_dm";
    readonly subject?: string;
    readonly memberActorIds: readonly string[];
    readonly readReceiptsEnabled: boolean;
    readonly spaceType?: "conversation" | "announcement" | "project";
    readonly historyPolicy: "full" | "since_join" | "off";
    readonly retentionDays: number | null;
    readonly legalHold: boolean;
    readonly notificationPolicy: "all" | "mentions" | "none";
    readonly externalAccess: "internal" | "guests" | "federated";
  }) => void;
}

export function ChatSidebar({
  loading,
  offline,
  spaces,
  directs,
  activeRoomId,
  onSelect,
  onCreateRoom,
}: ChatSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState<"chat_room" | "chat_dm">("chat_room");
  const [draftSpaceType, setDraftSpaceType] = useState<"conversation" | "announcement" | "project">(
    "conversation",
  );
  const [draftReadReceipts, setDraftReadReceipts] = useState(true);
  const [draftHistoryPolicy, setDraftHistoryPolicy] = useState<"full" | "since_join" | "off">(
    "full",
  );
  const [draftRetentionDays, setDraftRetentionDays] = useState("");
  const [draftLegalHold, setDraftLegalHold] = useState(false);
  const [draftNotificationPolicy, setDraftNotificationPolicy] = useState<
    "all" | "mentions" | "none"
  >("all");
  const [draftExternalAccess, setDraftExternalAccess] = useState<
    "internal" | "guests" | "federated"
  >("guests");
  const retentionDays = draftRetentionDays === "" ? null : Number(draftRetentionDays);
  const retentionIsValid =
    retentionDays === null ||
    (Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 36_500);

  return (
    <aside className="surf-sidebar chat-sidebar" aria-label="Spaces and direct messages">
      <div className="chat-sidebar-section">
        <span>Spaces</span>
        <button
          type="button"
          className="icon-btn chat-sidebar-add"
          aria-label="New conversation"
          onClick={() => {
            setCreating((v) => !v);
          }}
        >
          <PlusIcon size={14} />
        </button>
      </div>

      {creating ? (
        <div className="chat-sidebar-create" role="dialog" aria-label="New conversation">
          <select
            aria-label="Conversation type"
            value={draftKind}
            onChange={(e) => {
              setDraftKind(e.target.value as "chat_room" | "chat_dm");
            }}
          >
            <option value="chat_room">Space</option>
            <option value="chat_dm">Direct message</option>
          </select>
          {draftKind === "chat_room" ? (
            <select
              aria-label="Space type"
              value={draftSpaceType}
              onChange={(event) => {
                setDraftSpaceType(
                  event.target.value as "conversation" | "announcement" | "project",
                );
              }}
            >
              <option value="conversation">Conversation</option>
              <option value="announcement">Announcement</option>
              <option value="project">Project</option>
            </select>
          ) : null}
          <select
            aria-label="History policy"
            value={draftHistoryPolicy}
            onChange={(event) => {
              setDraftHistoryPolicy(event.target.value as "full" | "since_join" | "off");
            }}
          >
            <option value="full">Full history</option>
            <option value="since_join">History since joining</option>
            <option value="off">History off</option>
          </select>
          <select
            aria-label="Notification policy"
            value={draftNotificationPolicy}
            onChange={(event) => {
              setDraftNotificationPolicy(event.target.value as "all" | "mentions" | "none");
            }}
          >
            <option value="all">All messages</option>
            <option value="mentions">Mentions only</option>
            <option value="none">No notifications</option>
          </select>
          <select
            aria-label="External access"
            value={draftExternalAccess}
            onChange={(event) => {
              setDraftExternalAccess(event.target.value as "internal" | "guests" | "federated");
            }}
          >
            <option value="internal">Internal only</option>
            <option value="guests">Guests allowed</option>
            <option value="federated">Federated partners</option>
          </select>
          <input
            type="number"
            min={1}
            max={36_500}
            aria-label="Retention days"
            placeholder="Retention days (optional)"
            value={draftRetentionDays}
            onChange={(event) => {
              setDraftRetentionDays(event.target.value);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={draftLegalHold}
              onChange={(event) => {
                setDraftLegalHold(event.target.checked);
              }}
            />
            Legal hold
          </label>
          <input
            type="text"
            aria-label="Name or member actor id"
            placeholder={draftKind === "chat_dm" ? "Peer actor UUID" : "Space name"}
            value={draftName}
            onChange={(e) => {
              setDraftName(e.target.value);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={draftReadReceipts}
              onChange={(event) => {
                setDraftReadReceipts(event.target.checked);
              }}
            />
            Share read receipts
          </label>
          <button
            type="button"
            className="btn primary sm"
            disabled={draftName.trim().length === 0 || !retentionIsValid}
            onClick={() => {
              const name = draftName.trim();
              if (name.length === 0) return;
              if (draftKind === "chat_dm") {
                onCreateRoom({
                  kind: "chat_dm",
                  memberActorIds: [name],
                  readReceiptsEnabled: draftReadReceipts,
                  historyPolicy: draftHistoryPolicy,
                  retentionDays,
                  legalHold: draftLegalHold,
                  notificationPolicy: draftNotificationPolicy,
                  externalAccess: draftExternalAccess,
                });
              } else {
                onCreateRoom({
                  kind: "chat_room",
                  subject: name,
                  memberActorIds: [],
                  readReceiptsEnabled: draftReadReceipts,
                  spaceType: draftSpaceType,
                  historyPolicy: draftHistoryPolicy,
                  retentionDays,
                  legalHold: draftLegalHold,
                  notificationPolicy: draftNotificationPolicy,
                  externalAccess: draftExternalAccess,
                });
              }
              setDraftName("");
              setDraftReadReceipts(true);
              setDraftSpaceType("conversation");
              setDraftHistoryPolicy("full");
              setDraftRetentionDays("");
              setDraftLegalHold(false);
              setDraftNotificationPolicy("all");
              setDraftExternalAccess("guests");
              setCreating(false);
            }}
          >
            Create
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="chat-sidebar-state">Loading spaces…</p>
      ) : spaces.length === 0 ? (
        <p className="chat-sidebar-state">No spaces yet.</p>
      ) : (
        spaces.map((s) => {
          const selected = activeRoomId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className="surf-nav-row chat-nav-row"
              data-selected={selected}
              data-unread={s.unread > 0}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                onSelect(s.id);
              }}
            >
              <HashIcon size={16} />
              <span className="chat-nav-name truncate">{s.name}</span>
              {s.unread > 0 ? <span className="chat-unread-badge">{s.unread}</span> : null}
            </button>
          );
        })
      )}

      <div className="chat-sidebar-section">
        <span>Direct messages</span>
        <button
          type="button"
          className="icon-btn chat-sidebar-add"
          aria-label="Start direct message"
          onClick={() => {
            setDraftKind("chat_dm");
            setCreating(true);
          }}
        >
          <PlusIcon size={14} />
        </button>
      </div>

      {loading ? (
        <p className="chat-sidebar-state">Loading…</p>
      ) : directs.length === 0 ? (
        <p className="chat-sidebar-state">No direct messages.</p>
      ) : (
        directs.map((d) => {
          const selected = activeRoomId === d.id;
          return (
            <button
              key={d.id}
              type="button"
              className="surf-nav-row chat-nav-row"
              data-selected={selected}
              data-unread={d.unread > 0}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                onSelect(d.id);
              }}
            >
              <span className="chat-presence-wrap">
                <Avatar name={d.name} size={20} />
                <span
                  className="chat-presence-dot"
                  data-presence={d.presence}
                  aria-label={d.presence === "active" ? "Active" : "Offline"}
                />
              </span>
              <span className="chat-nav-name truncate">{d.name}</span>
              {d.unread > 0 ? <span className="chat-unread-badge">{d.unread}</span> : null}
            </button>
          );
        })
      )}

      {offline ? (
        <p className="chat-sidebar-state chat-sidebar-offline">Offline — chat rooms unavailable.</p>
      ) : null}
    </aside>
  );
}

/* ----------------------------------------------------------------
   Channel header
   ---------------------------------------------------------------- */

interface ChatChannelHeaderProps {
  readonly infoOpen: boolean;
  readonly onToggleInfo: () => void;
  readonly name: string;
  readonly memberCount: number;
  readonly onInvite?: ((actorId: string) => void) | undefined;
}

export function ChatChannelHeader({
  name,
  memberCount,
  onInvite,
  infoOpen,
  onToggleInfo,
}: ChatChannelHeaderProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteId, setInviteId] = useState("");
  return (
    <header className="chat-channel-header">
      <HashIcon size={16} />
      <span className="chat-channel-name">{name}</span>
      <span className="chat-channel-meta">· {memberCount} members</span>
      <div className="chat-channel-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="Channel info"
          aria-expanded={infoOpen}
          onClick={onToggleInfo}
        >
          <UsersIcon size={16} />
        </button>
        <Tooltip label="Add people" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Add people"
            onClick={() => {
              setInviteOpen((v) => !v);
            }}
          >
            <PlusIcon size={16} />
          </button>
        </Tooltip>
      </div>
      {inviteOpen ? (
        <div className="chat-channel-invite">
          <input
            type="text"
            aria-label="Actor id to invite"
            placeholder="Actor UUID"
            value={inviteId}
            onChange={(e) => {
              setInviteId(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn primary sm"
            disabled={inviteId.trim().length === 0}
            onClick={() => {
              onInvite?.(inviteId.trim());
              setInviteId("");
              setInviteOpen(false);
            }}
          >
            Invite
          </button>
        </div>
      ) : null}
    </header>
  );
}
