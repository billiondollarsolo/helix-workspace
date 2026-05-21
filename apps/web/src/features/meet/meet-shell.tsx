import {
  CalendarClock,
  CheckCircle2,
  Clipboard,
  FileVideo,
  Link,
  LoaderCircle,
  Mic,
  MonitorUp,
  Paperclip,
  PhoneOff,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useForm } from "@tanstack/react-form";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { createMeetRoom, endMeetRoom, mintMeetToken, type MeetRoomRecord } from "./api";
import { meetRoomsQueryOptions, type MeetRoomsQueryInput } from "./queries";

type MeetRoomStatus = "live" | "scheduled" | "ended";
type MeetTokenStatus = "ready" | "refreshing" | "expired";
type MeetRecordingStatus = "ready" | "processing";
type MeetSyncState = "backend" | "local";

interface MeetParticipant {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly muted: boolean;
  readonly camera: boolean;
}

interface MeetRecording {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly duration: string;
  readonly status: MeetRecordingStatus;
  readonly storageKey?: string;
}

interface MeetAttachment {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly detail?: string;
}

interface MeetRoom {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly roomName: string;
  readonly status: MeetRoomStatus;
  readonly startsAt: string;
  readonly owner: string;
  readonly description: string;
  readonly participants: readonly MeetParticipant[];
  readonly recordings: readonly MeetRecording[];
  readonly attachments: readonly MeetAttachment[];
  readonly tokenStatus: MeetTokenStatus;
  readonly tokenExpiresAt: string;
  readonly joinUrl?: string;
  readonly syncState: MeetSyncState;
}

const roomNameSchema = z.string().trim().min(1, "Room name is required.");
const roomSlugSchema = z.string().trim();

export function MeetShell({
  initialRoomId,
  roomsQueryInput,
}: {
  readonly initialRoomId?: string;
  readonly roomsQueryInput?: MeetRoomsQueryInput;
} = {}) {
  const [rooms, setRooms] = useState<readonly MeetRoom[]>([]);
  const roomsRef = useRef<readonly MeetRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState(initialRoomId ?? "");
  const [query, setQuery] = useState("");
  const [isJoined, setIsJoined] = useState(false);
  const [debouncedQuery] = useDebouncedValue(query, { wait: 300 });
  const roomsQuery = useQuery(meetRoomsQueryOptions(roomsQueryInput));
  const createRoomForm = useForm({
    defaultValues: {
      roomName: "",
      roomSlug: "",
    },
    onSubmit: ({ value }) => {
      const trimmedName = value.roomName.trim();
      if (trimmedName.length === 0) {
        return;
      }

      const nextRoomName = normalizeRoomName(value.roomSlug || trimmedName);
      createRoomForm.reset();

      void createMeetRoom({
        subject: trimmedName,
        roomName: nextRoomName,
        jitsiDomain: "meet.jit.si",
        metadata: { source: "web-shell" },
      })
        .then((room) => {
          const backendRoom = meetRoomRecordToRoom(room);
          setRooms((current) => [
            backendRoom,
            ...current.filter((candidate) => candidate.id !== backendRoom.id),
          ]);
          setSelectedRoomId(backendRoom.id);
          setIsJoined(false);
        })
        .catch(() => {
          const localRoom = createLocalRoom(trimmedName, nextRoomName);
          setRooms((current) => [localRoom, ...current]);
          setSelectedRoomId(localRoom.id);
          setIsJoined(false);
        });
    },
  });

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    if (initialRoomId !== undefined && rooms.some((room) => room.id === initialRoomId)) {
      setSelectedRoomId(initialRoomId);
      setIsJoined(false);
    }
  }, [initialRoomId, rooms]);

  useEffect(() => {
    const backendRooms = roomsQuery.data;
    if (backendRooms === undefined) {
      return;
    }

    const nextRooms = mergeBackendRoomsWithLocal(
      roomsRef.current,
      backendRooms.map(meetRoomRecordToRoom),
    );
    setRooms(nextRooms);
    setSelectedRoomId((current) =>
      nextRooms.some((room) => room.id === current)
        ? current
        : nextRooms.some((room) => room.id === initialRoomId)
          ? (initialRoomId ?? "")
          : (nextRooms[0]?.id ?? ""),
    );
    setIsJoined(false);
  }, [initialRoomId, roomsQuery.data]);

  const filteredRooms = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    return rooms.filter((room) => {
      const searchable =
        `${room.name} ${room.description} ${room.owner} ${room.roomName}`.toLowerCase();
      return !normalizedQuery || searchable.includes(normalizedQuery);
    });
  }, [debouncedQuery, rooms]);

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? rooms[0];
  const selectedRoomUrl = selectedRoom
    ? (selectedRoom.joinUrl ??
      `https://${selectedRoom.domain}/${encodeURIComponent(selectedRoom.roomName)}`)
    : "";
  const activeParticipants = selectedRoom?.participants.length ?? 0;
  const liveRooms = rooms.filter((room) => room.status === "live").length;
  const hasLocalRooms = rooms.some(isLocalRoom);
  const showBackendUnavailable = roomsQuery.isError || hasLocalRooms;

  const selectRoom = (roomId: string) => {
    setSelectedRoomId(roomId);
    setIsJoined(false);
  };

  const refreshToken = () => {
    if (!selectedRoom) {
      return;
    }

    if (isLocalRoom(selectedRoom)) {
      setRooms((current) =>
        current.map((room) =>
          room.id === selectedRoom.id
            ? { ...room, tokenStatus: "ready", tokenExpiresAt: "Offline/local" }
            : room,
        ),
      );
      return;
    }

    void mintMeetToken({ roomId: selectedRoom.id, moderator: true })
      .then((token) => {
        setRooms((current) =>
          current.map((room) =>
            room.id === selectedRoom.id
              ? {
                  ...room,
                  domain: token.jitsiDomain,
                  roomName: token.roomName,
                  joinUrl: token.joinUrl,
                  tokenStatus: "ready",
                  tokenExpiresAt: displayTime(token.expiresAt),
                }
              : room,
          ),
        );
      })
      .catch(() => {});
  };

  const joinRoom = () => {
    if (!selectedRoom) {
      return;
    }

    if (isLocalRoom(selectedRoom)) {
      setIsJoined(true);
      setRooms((current) =>
        current.map((room) =>
          room.id === selectedRoom.id ? { ...room, status: "live", tokenStatus: "ready" } : room,
        ),
      );
      return;
    }

    void mintMeetToken({ roomId: selectedRoom.id, moderator: true })
      .then((token) => {
        setIsJoined(true);
        setRooms((current) =>
          current.map((room) =>
            room.id === selectedRoom.id
              ? {
                  ...room,
                  domain: token.jitsiDomain,
                  roomName: token.roomName,
                  joinUrl: token.joinUrl,
                  status: "live",
                  tokenStatus: "ready",
                  tokenExpiresAt: displayTime(token.expiresAt),
                }
              : room,
          ),
        );
      })
      .catch(() => {});
  };

  const endRoom = () => {
    if (!selectedRoom) {
      return;
    }

    setIsJoined(false);
    if (isLocalRoom(selectedRoom)) {
      setRooms((current) =>
        current.map((room) => (room.id === selectedRoom.id ? { ...room, status: "ended" } : room)),
      );
      return;
    }

    void endMeetRoom(selectedRoom.id)
      .then((room) => {
        setRooms((current) =>
          current.map((candidate) =>
            candidate.id === selectedRoom.id ? meetRoomRecordToRoom(room) : candidate,
          ),
        );
      })
      .catch(() => {});
  };

  return (
    <section className="meet-page">
      <aside className="meet-sidebar" aria-label="Meeting rooms">
        <header className="meet-sidebar-header">
          <div>
            <h1 id="meet-title">Meet</h1>
            <p>
              {liveRooms} live, {rooms.length} total
            </p>
          </div>
          <span className="meet-brand-mark" aria-hidden="true">
            <Video aria-hidden="true" size={18} />
          </span>
        </header>

        <form
          className="meet-create"
          onSubmit={(event) => {
            event.preventDefault();
            void createRoomForm.handleSubmit();
          }}
        >
          <div>
            <label htmlFor="meet-room-name">Room name</label>
            <createRoomForm.Field
              name="roomName"
              validators={{
                onChange: validateWith(roomNameSchema),
                onSubmit: validateWith(roomNameSchema),
              }}
            >
              {(field) => (
                <>
                  <input
                    aria-describedby="meet-room-name-error"
                    aria-invalid={field.state.meta.errors.length > 0}
                    id="meet-room-name"
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="Product sync"
                    value={field.state.value}
                  />
                  <FieldErrors id="meet-room-name-error" errors={field.state.meta.errors} />
                </>
              )}
            </createRoomForm.Field>
          </div>
          <div>
            <label htmlFor="meet-room-slug">Jitsi room</label>
            <createRoomForm.Field
              name="roomSlug"
              validators={{
                onChange: validateWith(roomSlugSchema),
                onSubmit: validateWith(roomSlugSchema),
              }}
            >
              {(field) => (
                <>
                  <input
                    aria-describedby="meet-room-slug-error"
                    aria-invalid={field.state.meta.errors.length > 0}
                    id="meet-room-slug"
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="helix-product-sync"
                    value={field.state.value}
                  />
                  <FieldErrors id="meet-room-slug-error" errors={field.state.meta.errors} />
                </>
              )}
            </createRoomForm.Field>
          </div>
          <button className="helix-button" type="submit">
            <Plus aria-hidden="true" size={16} />
            Create room
          </button>
        </form>

        <label className="meet-search">
          <Search aria-hidden="true" size={16} />
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search rooms"
            value={query}
          />
        </label>

        {showBackendUnavailable ? (
          <div className="meet-empty-copy" role="status">
            {roomsQuery.isError
              ? "Meet backend unavailable. Offline/local rooms remain usable and backend rooms are not shown while offline."
              : "Offline/local rooms remain usable until the Meet backend accepts them."}
          </div>
        ) : null}

        <div
          className="meet-room-list"
          role="region"
          aria-busy={roomsQuery.isPending && rooms.length === 0 ? "true" : undefined}
          aria-label="Room list"
          tabIndex={0}
        >
          {roomsQuery.isPending && rooms.length === 0 ? (
            <p className="meet-empty-copy">Loading Meet rooms.</p>
          ) : roomsQuery.isError && filteredRooms.length === 0 ? (
            <div className="meet-empty-copy" role="alert">
              <strong>Meet backend unavailable</strong>
              <span>Room list could not reach the backend. Create a room to work offline.</span>
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="meet-empty-copy">
              <strong>No meeting rooms</strong>
              <span>No backend rooms match the current filters.</span>
            </div>
          ) : (
            filteredRooms.map((room) => (
              <button
                aria-label={`${room.name}${isLocalRoom(room) ? ", Offline/local" : ""}`}
                className={
                  room.id === selectedRoom?.id ? "meet-room-row selected" : "meet-room-row"
                }
                key={room.id}
                onClick={() => selectRoom(room.id)}
                type="button"
              >
                <span className={`meet-status-dot ${room.status}`} />
                <span>
                  <strong>{room.name}</strong>
                  <small>{isLocalRoom(room) ? "Offline/local" : room.startsAt}</small>
                </span>
                <span>{isLocalRoom(room) ? "Offline/local" : room.participants.length}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="meet-workspace" role="main" aria-labelledby="meet-title">
        {selectedRoom ? (
          <>
            <header className="meet-room-header">
              <div className="meet-room-heading">
                <div className="meet-room-icon">
                  <Video aria-hidden="true" size={22} />
                </div>
                <div>
                  <p className="meet-kicker">Helix Meet</p>
                  <h2>{selectedRoom.name}</h2>
                  <p>{selectedRoom.description}</p>
                </div>
              </div>
              <div className="meet-header-actions">
                <button
                  className="helix-button helix-button-secondary"
                  onClick={refreshToken}
                  type="button"
                >
                  <ShieldCheck aria-hidden="true" size={16} />
                  Refresh token
                </button>
                {isJoined ? (
                  <button
                    className="helix-button helix-button-destructive"
                    onClick={endRoom}
                    type="button"
                  >
                    <PhoneOff aria-hidden="true" size={16} />
                    End
                  </button>
                ) : (
                  <button className="helix-button" onClick={joinRoom} type="button">
                    <Video aria-hidden="true" size={16} />
                    Join
                  </button>
                )}
              </div>
            </header>

            <div className="meet-status-strip" aria-label="Meeting status">
              <StatusPill
                icon={Radio}
                label={statusLabel(selectedRoom.status)}
                tone={selectedRoom.status}
              />
              <StatusPill icon={Users} label={`${activeParticipants} participants`} />
              {isLocalRoom(selectedRoom) ? <StatusPill icon={Radio} label="Offline/local" /> : null}
              <StatusPill
                icon={ShieldCheck}
                label={tokenLabel(selectedRoom)}
                tone={selectedRoom.tokenStatus}
              />
              <StatusPill icon={Link} label={selectedRoom.domain} />
            </div>

            <div className="meet-content">
              <section className="meet-stage" aria-label="Jitsi meeting embed">
                <div className="meet-chrome">
                  <div>
                    <strong>{selectedRoom.roomName}</strong>
                    <span>{selectedRoomUrl}</span>
                  </div>
                  <div className="meet-chrome-actions" aria-label="Meeting device controls">
                    <button aria-label="Toggle microphone" type="button">
                      <Mic aria-hidden="true" size={16} />
                    </button>
                    <button aria-label="Toggle camera" type="button">
                      <Video aria-hidden="true" size={16} />
                    </button>
                    <button aria-label="Share screen" type="button">
                      <MonitorUp aria-hidden="true" size={16} />
                    </button>
                    <button aria-label="Copy meeting link" type="button">
                      <Clipboard aria-hidden="true" size={16} />
                    </button>
                  </div>
                </div>

                {isJoined ? (
                  <iframe
                    allow="camera; microphone; fullscreen; display-capture"
                    className="meet-iframe"
                    src={selectedRoomUrl}
                    title={`${selectedRoom.name} Jitsi room`}
                  />
                ) : (
                  <div className="meet-join-panel">
                    <Video aria-hidden="true" size={36} />
                    <h3>Ready to join</h3>
                    <p>The Jitsi room is prepared and will load here after joining.</p>
                    <button className="helix-button" onClick={joinRoom} type="button">
                      Join room
                    </button>
                  </div>
                )}
              </section>

              <section className="meet-details" aria-label="Meeting details">
                <section className="meet-panel">
                  <header>
                    <h3>Participants</h3>
                    <span>{selectedRoom.participants.length}</span>
                  </header>
                  <div className="meet-participant-list">
                    {selectedRoom.participants.map((participant) => (
                      <div className="meet-participant" key={participant.id}>
                        <span>{initials(participant.name)}</span>
                        <div>
                          <strong>{participant.name}</strong>
                          <small>{participant.role}</small>
                        </div>
                        <div className="meet-device-state">
                          <Mic
                            aria-label={participant.muted ? "Muted" : "Microphone on"}
                            size={14}
                          />
                          <Video
                            aria-label={participant.camera ? "Camera on" : "Camera off"}
                            size={14}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="meet-panel">
                  <header>
                    <h3>Recordings</h3>
                    <FileVideo aria-hidden="true" size={16} />
                  </header>
                  <RecordingList recordings={selectedRoom.recordings} />
                </section>

                <section className="meet-panel">
                  <header>
                    <h3>Attachments</h3>
                    <Paperclip aria-hidden="true" size={16} />
                  </header>
                  <AttachmentList attachments={selectedRoom.attachments} />
                </section>
              </section>
            </div>
          </>
        ) : (
          <div className="meet-empty">
            <CalendarClock aria-hidden="true" size={34} />
            <h2>No meeting selected</h2>
            <p>Create or select a room to start.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function StatusPill({
  icon: Icon,
  label,
  tone,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone?: MeetRoomStatus | MeetTokenStatus;
}) {
  return (
    <span className={tone ? `meet-status-pill ${tone}` : "meet-status-pill"}>
      <Icon aria-hidden="true" size={15} />
      {label}
    </span>
  );
}

function RecordingList({ recordings }: { readonly recordings: readonly MeetRecording[] }) {
  if (recordings.length === 0) {
    return <p className="meet-empty-copy">No recordings yet.</p>;
  }

  return (
    <div className="meet-recording-list">
      {recordings.map((recording) => (
        <div className="meet-recording" key={recording.id}>
          <FileVideo aria-hidden="true" size={17} />
          <div>
            <strong>{recording.title}</strong>
            <small>
              {recording.createdAt} - {recording.duration}
            </small>
          </div>
          {recording.status === "processing" ? (
            <LoaderCircle aria-label="Processing" className="meet-spin" size={15} />
          ) : (
            <CheckCircle2 aria-label="Ready" size={15} />
          )}
        </div>
      ))}
    </div>
  );
}

function AttachmentList({ attachments }: { readonly attachments: readonly MeetAttachment[] }) {
  if (attachments.length === 0) {
    return <p className="meet-empty-copy">No attachments yet.</p>;
  }

  return (
    <div className="meet-attachment-list">
      {attachments.map((attachment) => (
        <div className="meet-attachment" key={attachment.id}>
          <Paperclip aria-hidden="true" size={16} />
          <div>
            <strong>{attachment.title}</strong>
            <small>{attachment.detail ?? attachment.kind}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function statusLabel(status: MeetRoomStatus) {
  if (status === "live") {
    return "Live";
  }

  if (status === "scheduled") {
    return "Scheduled";
  }

  return "Ended";
}

function tokenLabel(room: MeetRoom) {
  if (isLocalRoom(room)) {
    return "Offline/local token";
  }

  if (room.tokenStatus === "ready") {
    return `Token ready until ${room.tokenExpiresAt}`;
  }

  if (room.tokenStatus === "refreshing") {
    return "Token pending";
  }

  return "Token expired";
}

function normalizeRoomName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return normalized.length > 0 ? `helix-${normalized}` : `helix-meet-${Date.now()}`;
}

function validateWith<T>(schema: z.ZodType<T>) {
  return ({ value }: { readonly value: unknown }) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

function FieldErrors({ errors, id }: { readonly errors: readonly unknown[]; readonly id: string }) {
  const messages = errors.filter((error): error is string => typeof error === "string");
  return messages.length === 0 ? null : (
    <span id={id} role="alert">
      {messages.join(" ")}
    </span>
  );
}

function createLocalRoom(name: string, roomName: string): MeetRoom {
  return {
    id: `meet-local-${Date.now()}`,
    name,
    domain: "meet.jit.si",
    roomName,
    status: "scheduled",
    startsAt: "Offline/local",
    owner: "Current user",
    description: "Local room available while Meet backend is offline.",
    participants: [
      { id: "current-user", name: "Current user", role: "Host", muted: false, camera: true },
    ],
    recordings: [],
    attachments: [],
    tokenStatus: "refreshing",
    tokenExpiresAt: "Offline/local",
    syncState: "local",
  };
}

function mergeBackendRoomsWithLocal(
  currentRooms: readonly MeetRoom[],
  backendRooms: readonly MeetRoom[],
) {
  const backendRoomIds = new Set(backendRooms.map((room) => room.id));
  const localRooms = currentRooms.filter(
    (room) => isLocalRoom(room) && !backendRoomIds.has(room.id),
  );
  return [...localRooms, ...backendRooms];
}

function isLocalRoom(room: MeetRoom) {
  return room.syncState === "local";
}

function meetRoomRecordToRoom(room: MeetRoomRecord): MeetRoom {
  const recordingArtifacts = room.recordingArtifacts ?? [];
  return {
    id: room.id,
    name: room.subject,
    domain: room.jitsiDomain,
    roomName: room.roomName,
    status: room.status === "ended" ? "ended" : "live",
    startsAt: room.status === "ended" ? "Ended" : "Now",
    owner: "Current user",
    description: "Backend-created Jitsi room.",
    participants: [
      { id: "current-user", name: "Current user", role: "Host", muted: false, camera: true },
    ],
    recordings: recordingArtifacts.map((artifact) => ({
      id: artifact.objectId,
      title: recordingTitle(artifact.storageKey),
      createdAt: displayDateTime(artifact.createdAt),
      duration: recordingDuration(artifact.startedAt, artifact.endedAt),
      status: "ready",
      storageKey: artifact.storageKey,
    })),
    attachments: recordingArtifacts.map((artifact) => ({
      id: artifact.objectId,
      title: recordingTitle(artifact.storageKey),
      kind: "Recording",
      detail: `${formatBytes(artifact.byteSize)} - ${artifact.mimeType}`,
    })),
    tokenStatus: "refreshing",
    tokenExpiresAt: "Pending",
    syncState: "backend",
  };
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function displayDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function recordingTitle(storageKey: string) {
  return storageKey.split("/").filter(Boolean).at(-1) ?? storageKey;
}

function recordingDuration(startedAt: string | null, endedAt: string | null) {
  if (startedAt === null || endedAt === null) {
    return "Recording artifact";
  }
  const started = new Date(startedAt);
  const ended = new Date(endedAt);
  const durationMs = ended.getTime() - started.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "Recording artifact";
  }
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  return `${minutes} min`;
}

function formatBytes(byteSize: number) {
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return "0 B";
  }
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }
  if (byteSize < 1024 * 1024) {
    return `${Math.round(byteSize / 1024)} KB`;
  }
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
