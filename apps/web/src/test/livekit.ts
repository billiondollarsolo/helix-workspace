/* A small in-memory stand-in for livekit-client's Room, for Meet unit tests.
   Use with:
     vi.mock("livekit-client", async (importOriginal) => ({
       ...(await importOriginal<typeof import("livekit-client")>()),
       Room: (await import("@/test/livekit")).FakeRoom,
     }));
   Enum values below mirror livekit-client 2.x (Track.Source, DisconnectReason). */

import { vi } from "vitest";

const CLIENT_INITIATED = 1;

export class FakeTrack {
  readonly attach = vi.fn((element: HTMLMediaElement) => element);
  readonly detach = vi.fn((element?: HTMLMediaElement) => element);
  readonly restartTrack = vi.fn(() => Promise.resolve());
  constructor(readonly source: string) {}
}

export class FakePublication {
  isMuted = false;
  constructor(public track: FakeTrack | undefined) {}
}

export class FakeParticipant {
  attributes: Record<string, string> = {};
  /** Token grants as LiveKit reports them; undefined means not reported yet. */
  permissions: Record<string, unknown> | undefined = undefined;
  isSpeaking = false;
  joinedAt = new Date();
  readonly publications = new Map<string, FakePublication>();
  constructor(
    readonly identity: string,
    public name: string,
  ) {}
  getTrackPublication(source: string): FakePublication | undefined {
    return this.publications.get(source);
  }
  publish(source: string, muted = false): FakePublication {
    const publication = new FakePublication(new FakeTrack(source));
    publication.isMuted = muted;
    this.publications.set(source, publication);
    return publication;
  }
  private enabled(source: string): boolean {
    const publication = this.publications.get(source);
    return publication !== undefined && !publication.isMuted;
  }
  get isMicrophoneEnabled() {
    return this.enabled("microphone");
  }
  get isCameraEnabled() {
    return this.enabled("camera");
  }
  get isScreenShareEnabled() {
    return this.enabled("screen_share");
  }
}

export class FakeLocalParticipant extends FakeParticipant {
  constructor(private readonly room: FakeRoom) {
    super("local-user", "Local User");
  }
  private toggle(source: string, enabled: boolean, event: string) {
    const existing = this.publications.get(source);
    if (enabled && existing === undefined) this.publish(source);
    else if (existing !== undefined) existing.isMuted = !enabled;
    this.room.emit(event);
  }
  readonly setMicrophoneEnabled = vi.fn((enabled: boolean) => {
    this.toggle("microphone", enabled, enabled ? "trackUnmuted" : "trackMuted");
    return Promise.resolve(undefined);
  });
  readonly setCameraEnabled = vi.fn((enabled: boolean) => {
    this.toggle("camera", enabled, enabled ? "trackUnmuted" : "trackMuted");
    return Promise.resolve(undefined);
  });
  readonly setScreenShareEnabled = vi.fn((enabled: boolean) => {
    this.toggle("screen_share", enabled, "localTrackPublished");
    return Promise.resolve(undefined);
  });
  readonly setAttributes = vi.fn((attributes: Record<string, string>) => {
    const next = { ...this.attributes };
    for (const [key, value] of Object.entries(attributes)) {
      if (value === "") Reflect.deleteProperty(next, key);
      else next[key] = value;
    }
    this.attributes = next;
    this.room.emit("participantAttributesChanged", attributes, this);
    return Promise.resolve();
  });
  readonly publishData = vi.fn<(data: Uint8Array, options?: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  );
}

export class FakeRoom {
  static instances: FakeRoom[] = [];
  static connectError: Error | null = null;

  state = "disconnected";
  readonly localParticipant: FakeLocalParticipant;
  readonly remoteParticipants = new Map<string, FakeParticipant>();
  activeSpeakers: FakeParticipant[] = [];
  canPlaybackAudio = true;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(readonly options: unknown) {
    this.localParticipant = new FakeLocalParticipant(this);
    FakeRoom.instances.push(this);
  }

  static latest(): FakeRoom {
    const room = FakeRoom.instances.at(-1);
    if (room === undefined) throw new Error("No FakeRoom was created.");
    return room;
  }

  static reset() {
    FakeRoom.instances = [];
    FakeRoom.connectError = null;
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return true;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  readonly connect = vi.fn<(url: string, token: string) => Promise<void>>(() => {
    if (FakeRoom.connectError !== null) return Promise.reject(FakeRoom.connectError);
    this.state = "connected";
    return Promise.resolve();
  });

  readonly disconnect = vi.fn(() => {
    this.state = "disconnected";
    this.emit("disconnected", CLIENT_INITIATED);
    return Promise.resolve();
  });

  readonly startAudio = vi.fn(() => {
    this.canPlaybackAudio = true;
    return Promise.resolve();
  });

  /** Adds a remote participant and fires participantConnected. */
  addRemote(identity: string, name: string): FakeParticipant {
    const participant = new FakeParticipant(identity, name);
    this.remoteParticipants.set(identity, participant);
    this.emit("participantConnected", participant);
    return participant;
  }

  removeRemote(identity: string) {
    const participant = this.remoteParticipants.get(identity);
    this.remoteParticipants.delete(identity);
    this.emit("participantDisconnected", participant);
  }
}
