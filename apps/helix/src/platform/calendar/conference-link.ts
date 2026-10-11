import { isJsonObject, type JsonObject } from "@helix/sdk-types";
import type { CalendarEventRecord } from "./types.js";
import type { ICalComponent } from "./vevent-parser.js";

/**
 * An event's video-call link. `meet` is a Helix Meet room this deployment
 * created (`metadata.conference = { provider: "meet", roomId, joinCode, joinUrl }`);
 * `external` is a meeting URL read from an inbound invitation, which is only
 * ever shown as a plain link and never treated as a Helix room.
 */
export interface CalendarConferenceLink {
  readonly provider: "meet" | "external";
  /** Absolute http(s) URL. */
  readonly joinUrl: string;
  readonly label: string;
}

const MEET_JOIN_LABEL = "Join with Helix Meet";
const EXTERNAL_JOIN_LABEL = "Join video call";
const MAX_CONFERENCE_URL_LENGTH = 2048;

/**
 * The event's join link. A Helix Meet link is rebuilt from the room's join code
 * on the deployment's public origin (`HELIX_PUBLIC_URL`) when one is given, so
 * recipients always get an absolute URL to this deployment.
 */
export function eventConferenceLink(
  event: Pick<CalendarEventRecord, "metadata">,
  publicBaseUrl: string | undefined,
): CalendarConferenceLink | null {
  const value = event.metadata.conference;
  if (!isJsonObject(value)) return null;
  if (value.provider === "meet") {
    const joinUrl =
      publicBaseUrl !== undefined && typeof value.joinCode === "string" && value.joinCode !== ""
        ? meetJoinUrl(publicBaseUrl, value.joinCode)
        : absoluteHttpUrl(value.joinUrl);
    return joinUrl === null ? null : { provider: "meet", joinUrl, label: MEET_JOIN_LABEL };
  }
  if (value.provider === "external") {
    const joinUrl = absoluteHttpUrl(value.joinUrl);
    return joinUrl === null ? null : { provider: "external", joinUrl, label: EXTERNAL_JOIN_LABEL };
  }
  return null;
}

function meetJoinUrl(publicBaseUrl: string, joinCode: string): string | null {
  try {
    const url = new URL("/meet", publicBaseUrl);
    url.searchParams.set("code", joinCode);
    return absoluteHttpUrl(url.toString());
  } catch {
    return null;
  }
}

/**
 * iCalendar properties for a join link: RFC 7986 `CONFERENCE` and the
 * `X-GOOGLE-CONFERENCE` extension that many clients read instead.
 */
export function conferenceIcsLines(
  link: CalendarConferenceLink,
  escapeParam: (value: string) => string,
): readonly string[] {
  return [
    `CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=${escapeParam(link.label)}:${link.joinUrl}`,
    `X-GOOGLE-CONFERENCE:${link.joinUrl}`,
  ];
}

/** The description with the join line appended once. */
export function descriptionWithConference(
  description: string | null | undefined,
  link: CalendarConferenceLink,
): string {
  const joinLine = `${link.label}: ${link.joinUrl}`;
  if (description === null || description === undefined || description.trim() === "") {
    return joinLine;
  }
  return description.includes(link.joinUrl) ? description : `${description}\n\n${joinLine}`;
}

/**
 * The meeting link of an inbound invitation's VEVENT, from `CONFERENCE`,
 * `X-GOOGLE-CONFERENCE`, or `URL`, in that order. It is always recorded as an
 * external link: an invitation can never name a room on this deployment.
 */
export function inboundConferenceMetadata(component: ICalComponent): JsonObject | null {
  for (const name of ["conference", "x-google-conference", "url"]) {
    for (const property of component.getAllProperties(name)) {
      const joinUrl = absoluteHttpUrl(property.getFirstValue());
      if (joinUrl !== null) return { provider: "external", joinUrl };
    }
  }
  return null;
}

/** A bounded absolute http(s) URL with no characters that need iCalendar escaping. */
function absoluteHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_CONFERENCE_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const href = url.toString();
  return /^[\x21-\x7e]+$/u.test(href) && !/["\\]/u.test(href) ? href : null;
}
