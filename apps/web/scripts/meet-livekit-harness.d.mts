import type { BrowserContext, Page } from "@playwright/test";

export declare const HARNESS_ORIGIN: string;
export declare const CHAT_TOPIC: string;

export interface HarnessParticipant {
  readonly page: Page;
  readonly problems: string[];
  readonly joined: boolean;
}

export interface HarnessRoomState {
  readonly connected: boolean;
  readonly connectError?: string | null;
  readonly identity?: string;
  readonly remotes?: readonly {
    readonly identity: string;
    readonly attributes: Readonly<Record<string, string>>;
    readonly subscribed: readonly string[];
  }[];
  readonly chat?: readonly { readonly from: string | null; readonly text: string }[];
}

export interface HarnessMediaStats {
  readonly inbound: Readonly<Record<"audio" | "video", number>>;
  readonly outbound: Readonly<Record<"audio" | "video", number>>;
  readonly dtls: readonly string[];
  readonly candidateTypes: readonly string[];
  readonly connectionStates: readonly string[];
}

export declare function instrumentPeerConnections(
  context: BrowserContext,
  options?: { readonly relayOnly?: boolean },
): Promise<void>;
export declare function openLiveKitParticipant(
  context: BrowserContext,
  options: { readonly serverUrl: string; readonly token: string; readonly timeoutMs?: number },
): Promise<HarnessParticipant>;
export declare function roomState(page: Page): Promise<HarnessRoomState>;
export declare function sendChat(page: Page, text: string): Promise<void>;
export declare function raiseHand(page: Page): Promise<void>;
export declare function disconnect(page: Page): Promise<void>;
export declare function mediaStats(page: Page): Promise<HarnessMediaStats>;
