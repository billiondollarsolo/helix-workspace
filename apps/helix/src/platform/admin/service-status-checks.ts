import type { AdminServiceStatus } from "./services.js";

/** Meet's media server check: undefined when Meet is not configured. */
export function liveKitServerCheck(up: boolean | undefined): {
  readonly key: string;
  readonly label: string;
  readonly status: AdminServiceStatus;
  readonly evidence: string;
} {
  return {
    key: "liveKitServer",
    label: "LiveKit media server",
    status: up === true ? "ready" : "missing",
    evidence:
      up === undefined
        ? "Meet is not configured."
        : up
          ? "The media server answered its health check."
          : "The media server did not answer its health check.",
  };
}
