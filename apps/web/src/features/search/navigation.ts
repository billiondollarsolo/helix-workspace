import type { GlobalSearchHit } from "./api";

export interface SearchHitNavigationTarget {
  readonly route: "/mail" | "/chat" | "/drive" | "/calendar";
  readonly event?: string;
  readonly file?: string;
  readonly message?: string;
  readonly room?: string;
  readonly thread?: string;
}

export function navigationTargetForSearchHit(hit: GlobalSearchHit): SearchHitNavigationTarget {
  const hitUrl = urlFromHitUrl(hit.url);
  const path = hitUrl?.pathname;
  const segments = path?.split("/").filter(Boolean) ?? [];
  if (segments[0] === "docs") {
    const doc = segments[1];
    return doc === undefined
      ? { route: "/drive" }
      : { route: "/drive", file: decodeURIComponent(doc) };
  }

  if (segments[0] === "mail") {
    return {
      route: "/mail",
      thread: stringAttribute(hit, "threadId") ?? decodedSegment(segments[1]),
      message:
        stringAttribute(hit, "messageId") ?? hitUrl?.searchParams.get("message") ?? undefined,
    };
  }
  if (segments[0] === "chat") {
    return {
      route: "/chat",
      room: stringAttribute(hit, "roomId") ?? decodedSegment(segments[1]),
      message:
        stringAttribute(hit, "messageId") ?? hitUrl?.searchParams.get("message") ?? undefined,
    };
  }
  if (segments[0] === "drive") {
    return {
      route: "/drive",
      file:
        stringAttribute(hit, "objectId") ??
        stringAttribute(hit, "fileId") ??
        stringAttribute(hit, "driveObjectId") ??
        hitUrl?.searchParams.get("file") ??
        hitUrl?.searchParams.get("id") ??
        decodedSegment(segments[1]),
    };
  }
  if (segments[0] === "calendar") {
    return {
      route: "/calendar",
      event:
        stringAttribute(hit, "eventId") ??
        (segments[1] === "events" ? decodedSegment(segments[2]) : decodedSegment(segments[1])),
    };
  }

  switch (hit.type) {
    case "mail":
      return {
        route: "/mail",
        thread: stringAttribute(hit, "threadId"),
        message: stringAttribute(hit, "messageId"),
      };
    case "chat":
      return {
        route: "/chat",
        room: stringAttribute(hit, "roomId"),
        message: stringAttribute(hit, "messageId"),
      };
    case "docs":
      return {
        route: "/drive",
        file:
          stringAttribute(hit, "docId") ??
          stringAttribute(hit, "documentId") ??
          stringAttribute(hit, "objectId"),
      };
    case "drive":
      return {
        route: "/drive",
        file:
          stringAttribute(hit, "objectId") ??
          stringAttribute(hit, "fileId") ??
          stringAttribute(hit, "driveObjectId"),
      };
    case "calendar":
      return { route: "/calendar", event: stringAttribute(hit, "eventId") };
  }
}

function urlFromHitUrl(url: string | undefined): URL | undefined {
  if (url === undefined || url.length === 0) {
    return undefined;
  }

  try {
    return new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.href);
  } catch {
    return undefined;
  }
}

function stringAttribute(hit: GlobalSearchHit, key: string): string | undefined {
  const value = hit.attributes?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodedSegment(segment: string | undefined): string | undefined {
  if (segment === undefined || segment.length === 0) {
    return undefined;
  }

  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
