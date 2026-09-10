/** Loud local skips; CI requires migrated PostgreSQL and fails missing resources. */
const REQUIRE_LIVE_SUITES = "HELIX_REQUIRE_LIVE_SUITES";

interface LiveSuiteRequirement {
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
function skipUnless(available: boolean, requirement: LiveSuiteRequirement): boolean {
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
