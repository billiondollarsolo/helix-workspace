/* Prefilled-intent search params that person actions put on the target route.
   Mail, Chat and Calendar read them to open compose, a DM or the event editor. */
import {
  optionalEnumSearchParam,
  optionalStringSearchParam,
  optionalUuidSearchParam,
} from "@/lib/search-params";
import { isValidEmailAddress } from "./person-ref";

/** `/mail?compose=new&to=a@x.com,b@y.org` opens a new message to those addresses. */
export interface MailComposeHandoff {
  readonly compose?: "new";
  readonly to?: string;
}

/** `/chat?dm=<actorId>` opens (or starts) the direct message with that member. */
export interface ChatDirectMessageHandoff {
  readonly dm?: string;
}

/** `/calendar?create=event&attendees=a@x.com` opens the event editor with those guests. */
export interface CalendarCreateHandoff {
  readonly create?: "event";
  readonly attendees?: string;
}

export function mailComposeHandoffFromSearch(search: Record<string, unknown>): MailComposeHandoff {
  const compose = optionalEnumSearchParam(search.compose, ["new"] as const);
  const to = emailListSearchParam(search.to);
  return {
    ...(compose === undefined ? {} : { compose }),
    ...(to === undefined ? {} : { to }),
  };
}

export function chatDirectMessageHandoffFromSearch(
  search: Record<string, unknown>,
): ChatDirectMessageHandoff {
  const dm = optionalUuidSearchParam(search.dm);
  return dm === undefined ? {} : { dm };
}

export function calendarCreateHandoffFromSearch(
  search: Record<string, unknown>,
): CalendarCreateHandoff {
  const create = optionalEnumSearchParam(search.create, ["event"] as const);
  const attendees = emailListSearchParam(search.attendees);
  return {
    ...(create === undefined ? {} : { create }),
    ...(attendees === undefined ? {} : { attendees }),
  };
}

/** Comma-separated addresses; invalid entries are dropped rather than prefilled. */
function emailListSearchParam(value: unknown): string | undefined {
  const raw = optionalStringSearchParam(value);
  if (raw === undefined) return undefined;
  const addresses = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(isValidEmailAddress);
  return addresses.length > 0 ? addresses.join(",") : undefined;
}
