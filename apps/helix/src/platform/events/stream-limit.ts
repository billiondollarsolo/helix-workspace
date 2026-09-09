/* Per-org cap on concurrent event-stream connections.
 *
 * `/events/ws` is exempt from the tenant `api_rps_limit` meter (see
 * `isLongLivedStreamPath` in server.ts): a rate limit bounds work per unit
 * time, which is the wrong control for a connection that costs one upgrade and
 * then lives for minutes. The admin console opens its sockets as a section
 * mounts, so under the rate meter those upgrades landed in the same one-second
 * window as the section's own queries and pushed the page over its budget.
 *
 * Exempting them removed the only thing bounding how many an org could hold
 * open, so this is the replacement — and it is the control that actually fits:
 * a ceiling on simultaneous connections, not on how fast they are opened.
 */

/** Enough for a generous number of tabs per operator across a workspace, low
 *  enough that one org cannot exhaust the process's socket budget. Tabs are the
 *  unit that matters: the client shares one socket per distinct subject per
 *  tab, so a busy operator with the console, mail and chat open is a handful,
 *  not dozens. */
export const DEFAULT_MAX_EVENT_STREAMS_PER_ORG = 64;

export interface EventStreamLimiterOptions {
  readonly maxPerOrg?: number;
}

/** Hands out connection leases and takes them back. One instance per process;
 *  the count is in memory because it is a property of *this* process's open
 *  sockets, not of the cluster. */
export class EventStreamLimiter {
  private readonly counts = new Map<string, number>();
  private readonly maxPerOrg: number;

  constructor(options: EventStreamLimiterOptions = {}) {
    this.maxPerOrg = options.maxPerOrg ?? DEFAULT_MAX_EVENT_STREAMS_PER_ORG;
  }

  /** Reserve a slot. Returns a release function, or `null` when the org is at
   *  its ceiling — the caller must then refuse the upgrade. */
  acquire(orgId: string): (() => void) | null {
    const current = this.counts.get(orgId) ?? 0;
    if (current >= this.maxPerOrg) {
      return null;
    }
    this.counts.set(orgId, current + 1);

    let released = false;
    return () => {
      /* Idempotent: a socket can emit both `error` and `close`, and releasing
         twice would let an org open one extra stream per flap until the count
         underflowed to zero and the cap stopped meaning anything. */
      if (released) {
        return;
      }
      released = true;
      const next = (this.counts.get(orgId) ?? 1) - 1;
      if (next <= 0) {
        /* Delete rather than store 0, so an idle process does not accumulate a
           map entry per org that ever connected. */
        this.counts.delete(orgId);
        return;
      }
      this.counts.set(orgId, next);
    };
  }

  /** Open streams for one org. Exposed for tests and diagnostics. */
  activeFor(orgId: string): number {
    return this.counts.get(orgId) ?? 0;
  }
}
