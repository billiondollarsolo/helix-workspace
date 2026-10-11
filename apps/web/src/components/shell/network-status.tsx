/* Offline banner — a full-width strip above the shell while the browser has
   no connection, then a short "back online" note. It describes the device's
   connection only; a failing server is reported by the surface that called it.
   Surfaces use `useOnline()` to tell the two apart. */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import { Wifi as OnlineIcon, WifiOff as OfflineIcon } from "lucide-react";

type NetworkAnnouncement = "offline" | "reconnected" | null;

function subscribeToNetworkStatus(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function readNetworkStatus(): boolean {
  return navigator.onLine;
}

/** Whether the browser reports a network connection. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeToNetworkStatus, readNetworkStatus, () => true);
}

export function NetworkStatus() {
  const online = useOnline();
  const wasOfflineRef = useRef(!online);
  const [announcement, setAnnouncement] = useState<NetworkAnnouncement>(online ? null : "offline");
  const hideReconnected = useDebouncer(() => setAnnouncement(null), { wait: 4_000 });

  useEffect(() => {
    if (!online) {
      hideReconnected.cancel();
      wasOfflineRef.current = true;
      setAnnouncement("offline");
      return;
    }
    if (!wasOfflineRef.current) {
      return;
    }
    wasOfflineRef.current = false;
    setAnnouncement("reconnected");
    void hideReconnected.maybeExecute();
  }, [hideReconnected, online]);

  if (announcement === null) {
    return null;
  }

  return (
    <div className={`network-status ${announcement}`} role="status" aria-atomic="true">
      {announcement === "offline" ? (
        <>
          <OfflineIcon size={16} aria-hidden="true" />
          <span>
            <strong>You’re offline.</strong> Helix will reconnect when your connection returns.
            Changes you haven’t saved stay on this device.
          </span>
        </>
      ) : (
        <>
          <OnlineIcon size={16} aria-hidden="true" />
          <span>Back online.</span>
        </>
      )}
    </div>
  );
}
