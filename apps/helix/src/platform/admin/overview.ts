/**
 * `GET /api/admin/overview` — the console's landing page in one request.
 *
 * Admin › Overview reads five figures, each from the endpoint that owns it:
 * domains, security policies, platform config, the directory and core apps.
 * As five client requests that is five of the tenant's five-per-second budget
 * (`api_rps_limit`) on top of the three the app shell already spends, so the
 * page could not load without tripping the limiter it was reporting on. The
 * client grew a release queue to stagger them — roughly a second of deliberate
 * self-throttling on the console's front door, and it still earned a 429 on a
 * genuinely cold load because the shell's cost had been undercounted.
 *
 * One request removes the class of problem instead of pacing around it.
 *
 * THE PROPERTY THIS MUST NOT LOSE
 *
 * Overview's whole discipline is that a figure may only be rendered from a
 * response that actually arrived: a card says "not read" rather than "0" when
 * its source is unavailable, and the page refuses to claim "nothing needs
 * attention" unless every check answered. Five independent requests gave that
 * for free — one endpoint being down left the other four cards accurate.
 *
 * A naive aggregate would throw that away: one failing source would fail the
 * whole request and blank all five cards, turning a precise reading into a
 * total outage. So the fan-out happens here, each source is caught
 * individually, and every signal reports its own status. The client keeps the
 * same three-way distinction it had — read / not read / empty — and gains a
 * reason string it never had, because a 403 on one source used to be
 * indistinguishable from that source being down.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@helix/sdk-types";
import { adminConsoleReadScope, canReadAdminConsole, sendForbidden } from "./console-shared.js";

/** One signal's reading. `unavailable` is a statement about the *request*, not
 *  about the workspace — the client must never render it as a zero. */
export type AdminOverviewSignal<Data> =
  | { readonly status: "ok"; readonly data: Data }
  | { readonly status: "unavailable"; readonly reason: string };

export interface AdminOverviewResponse {
  readonly signals: {
    readonly domains: AdminOverviewSignal<unknown>;
    readonly policies: AdminOverviewSignal<unknown>;
    readonly platformConfig: AdminOverviewSignal<unknown>;
    readonly directory: AdminOverviewSignal<unknown>;
    readonly coreApps: AdminOverviewSignal<unknown>;
  };
}

/** Each reader returns exactly what its own endpoint returns, so the client
 *  parses one shape per signal rather than a second, aggregate-only shape that
 *  could drift away from the section pages. */
export interface AdminOverviewReaders {
  readDomains: (actor: Actor) => Promise<unknown>;
  readPolicies: (actor: Actor) => Promise<unknown>;
  readPlatformConfig: (actor: Actor) => Promise<unknown>;
  readDirectory: (actor: Actor) => Promise<unknown>;
  readCoreApps: (actor: Actor) => Promise<unknown>;
}

export interface RegisterAdminOverviewRoutesOptions extends AdminOverviewReaders {
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  /** Reports a failed signal so an outage is visible in logs, not only to the
   *  operator looking at a card. */
  readonly onSignalError?: (input: { readonly signal: string; readonly error: unknown }) => void;
}

/** Run one reader, converting a rejection into an `unavailable` reading rather
 *  than letting it take the other four down with it. */
async function readSignal(
  signal: string,
  read: () => Promise<unknown>,
  onSignalError: RegisterAdminOverviewRoutesOptions["onSignalError"],
): Promise<AdminOverviewSignal<unknown>> {
  try {
    return { status: "ok", data: await read() };
  } catch (error) {
    onSignalError?.({ signal, error });
    /* The message, not the stack or the error object: this crosses to a browser
       and an operator reads it in a banner. A source that throws something
       without a message still has to produce a sentence. */
    const reason =
      error instanceof Error && error.message.length > 0
        ? error.message
        : "The source did not return a usable response.";
    return { status: "unavailable", reason };
  }
}

export function registerAdminOverviewRoutes(
  app: FastifyInstance,
  options: RegisterAdminOverviewRoutesOptions,
): void {
  app.get("/api/admin/overview", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    /* The same gate the five underlying endpoints use. Deliberately checked
       once here rather than relying on the readers: an aggregate that let an
       unauthorized caller reach five stores and then reported five
       `unavailable` readings would leak the shape of the console to someone who
       cannot see it. */
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }

    /* Concurrent: this is one request against the rate limit either way, and
       the five reads are independent. Sequential would make the page as slow as
       the sum of its sources. */
    const [domains, policies, platformConfig, directory, coreApps] = await Promise.all([
      readSignal("domains", () => options.readDomains(actor), options.onSignalError),
      readSignal("policies", () => options.readPolicies(actor), options.onSignalError),
      readSignal("platformConfig", () => options.readPlatformConfig(actor), options.onSignalError),
      readSignal("directory", () => options.readDirectory(actor), options.onSignalError),
      readSignal("coreApps", () => options.readCoreApps(actor), options.onSignalError),
    ]);

    return {
      signals: { domains, policies, platformConfig, directory, coreApps },
    } satisfies AdminOverviewResponse;
  });
}
