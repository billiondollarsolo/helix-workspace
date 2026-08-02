import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDebouncer } from "@tanstack/react-pacer/debouncer";

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

export function NetworkStatus() {
  const online = useSyncExternalStore(subscribeToNetworkStatus, readNetworkStatus, () => true);
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
    <div
      className={`network-status ${announcement}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="network-status-dot" aria-hidden="true" />
      <span>
        {announcement === "offline"
          ? "You’re offline. Unsaved changes stay on this device until Helix reconnects."
          : "Back online. Syncing saved changes…"}
      </span>
    </div>
  );
}
