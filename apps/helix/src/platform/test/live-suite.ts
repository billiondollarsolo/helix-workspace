/**
 * Loud skips for suites that need a resource the runner may not have.
 *
 * Eleven suites in this app gate themselves on `DATABASE_URL` and two on a
 * downloaded test corpus. When the resource is absent they skip, and a skip
 * reads as a pass: `pnpm test:cross-tenant-isolation` exited 0 with "2 skipped"
 * while proving nothing about tenant isolation, and the main CI test job — which
 * sets no `DATABASE_URL` — skips every one of them on every run.
 *
 * A skipped integration suite is not a neutral event. It is coverage the report
 * claims and does not have, which is the same failure as a green gate that is
 * looking at the wrong page. So these helpers say so, in terms that tell the
 * reader what did not run and how to run it.
 *
 * Deliberately free of any `vitest` import: this file lives under `src/` and is
 * compiled with the app, and reaching for a devDependency from there would make
 * a production install a build failure. Callers pass the boolean into the
 * `skip` option or `describe.skipIf` they already use.
 */

/** Set to any non-empty value to turn a missing resource into a failure.
 *
 *  The intended use is CI: a pipeline that silently skips its integration
 *  suites is reporting coverage it does not have. It is opt-in rather than
 *  automatic on `CI` because turning it on requires wiring a database into the
 *  job first, and a red build with no way to go green is not an improvement. */
const REQUIRE_LIVE_SUITES = "HELIX_REQUIRE_LIVE_SUITES";

export interface LiveSuiteRequirement {
  /** What did not run, in the reader's terms. */
  readonly suite: string;
  /** The resource it needs — an env var name, a path. */
  readonly requires: string;
  /** The command that makes it available. */
  readonly howTo: string;
}

function announceSkip(requirement: LiveSuiteRequirement): void {
  const message = [
    "",
    "  ┌─────────────────────────────────────────────────────────────────",
    `  │ SUITE DID NOT RUN: ${requirement.suite}`,
    `  │ Requires: ${requirement.requires}`,
    `  │ To run it: ${requirement.howTo}`,
    `  │ Set ${REQUIRE_LIVE_SUITES}=1 to make this a failure instead.`,
    "  └─────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");

  if ((process.env[REQUIRE_LIVE_SUITES] ?? "") !== "") {
    throw new Error(
      `${requirement.suite} requires ${requirement.requires}, and ${REQUIRE_LIVE_SUITES} is set. ${requirement.howTo}`,
    );
  }
  /* `process.stderr` rather than `console.warn`: vitest intercepts console
     output and attributes it to a running test, so a warning emitted at module
     scope by a file whose suite is skipped is captured and never shown — which
     is precisely the case this exists to announce. */
  process.stderr.write(`${message}\n`);
}

/**
 * `true` when the suite must be skipped — and says so loudly first.
 *
 * Call at module scope: the module is evaluated even when the `describe` is
 * skipped, which is what lets the warning appear at all.
 */
export function skipUnless(available: boolean, requirement: LiveSuiteRequirement): boolean {
  if (available) {
    return false;
  }
  announceSkip(requirement);
  return true;
}

/** Suites needing a migrated PostgreSQL. */
export function skipUnlessLiveDatabase(suite: string): boolean {
  return skipUnless((process.env.DATABASE_URL ?? "") !== "", {
    suite,
    requires: "DATABASE_URL — a live PostgreSQL with migrations applied",
    howTo: "docker compose up -d postgres && pnpm --filter @helix/app db:migrate",
  });
}

/** Suites needing the downloaded document corpus. */
export function skipUnlessTestCorpus(suite: string, present: boolean, corpusPath: string): boolean {
  return skipUnless(present, {
    suite,
    requires: `the test corpus at ${corpusPath}`,
    howTo: "pnpm --filter @helix/app db:fetch:corpus",
  });
}
