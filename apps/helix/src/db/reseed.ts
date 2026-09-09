/* reseed.ts
 *
 * Wipes every predictable-UUID row (the old `00000000-…` seed data) and
 * rebuilds the dev workspace from scratch using random UUIDs for every
 * entity. The corpus seed handles files; this script handles the bits
 * around it (actor randomization, supporting principals, role variety).
 *
 * Idempotent: re-running produces a fresh randomized dataset on each
 * invocation. Login email/passwords stay stable (the only thing the user
 * needs to remember).
 *
 * Run with:  pnpm db:reseed
 *
 * After:
 *   • All actor ids, file ids, folder ids, etc. are crypto.randomUUID()
 *   • Logins (admin@/user@/maya@/…) point at fresh random actor ids
 *   • Files have varied roles — viewer/commenter/editor/owner mix —
 *     so the native helix editors surface different modes per file
 *   • No stub objects: every drive entry resolves to real bytes that
 *     open / render in the UI */

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type postgres from "postgres";
import { hashPassword } from "@better-auth/utils/password";
import { withTenantPostgresContext } from "../platform/tenancy/postgres-roles.js";
import { createSqlClient } from "./client.js";

/** Derive a stable Better-Auth user id from an email. Sessions reference
 *  `user.id`, so keeping this constant across reseeds means existing
 *  browser cookies survive — no "why do I keep getting logged out?"
 *  surprises every time the dev re-hydrates the workspace. */
function stableUserIdForEmail(email: string): string {
  const hash = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 24);
  return `helix-user-${hash}`;
}

/** Scopes granted to admin logins — covers every read/write surface
 *  plus admin tooling. Mirrors `ADMIN_SCOPES` from seed-login-accounts. */
const ADMIN_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "mail.external",
  "mail.admin",
  "drive.read",
  "drive.write",
  "drive.delete",
  "docs.read",
  "docs.write",
  "docs.comment",
  "calendar.read",
  "calendar.write",
  "calendar.manage",
  "calendar.external",
  "chat.read",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "sheets.read",
  "sheets.write",
  "slides.read",
  "slides.write",
  "notifications.read",
  "notifications.write",
  "search.read",
  "tools:read",
  "tools:write",
  "webhooks.read",
  "webhooks.write",
  "admin",
  "admin.users",
  "admin.audit",
  "admin.agents",
  "admin.plugins",
  "admin.webhooks",
  "admin.config.read",
  "admin.config.write",
  "admin.console.read",
  "admin.console.write",
  "admin.ai",
] as const;

/** Scopes for non-admin principals — read/write on every app surface
 *  but no admin tooling. */
const USER_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "drive.read",
  "drive.write",
  "docs.read",
  "docs.write",
  "docs.comment",
  "calendar.read",
  "calendar.write",
  "chat.read",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "sheets.read",
  "sheets.write",
  "slides.read",
  "slides.write",
  "notifications.read",
  "notifications.write",
  "search.read",
] as const;

interface PrincipalSpec {
  readonly email: string;
  readonly displayName: string;
  readonly title?: string;
  readonly admin?: boolean;
  /** Login password. When omitted, no login is created for this actor —
   *  the principal is a "supporting cast" actor referenced from other
   *  seeds (e.g. shares) but not directly sign-in-able. */
  readonly password?: string;
}

/** Supporting cast for the seeded org. Emails are stable handles the
 *  manifest references; actor IDs are randomized per reseed.
 *
 *  Every principal gets a sign-in-able login. Password is the email's
 *  local-part + "-pass" by default so it's easy to remember during dev
 *  testing (e.g. `morgan-pass` signs in `morgan@helix.local`). The two
 *  primary accounts (`admin@`, `user@`) keep their well-known passwords. */
const PRINCIPALS: readonly PrincipalSpec[] = [
  {
    email: "admin@helix.local",
    displayName: "Avery Park",
    title: "Workspace admin",
    admin: true,
    password: "helix-admin-password",
  },
  {
    email: "user@helix.local",
    displayName: "Riley Chen",
    title: "Customer success",
    password: "helix-user-password",
  },
  {
    email: "morgan@helix.local",
    displayName: "Morgan Diaz",
    title: "Head of Product",
    password: "morgan-pass",
  },
  {
    email: "sasha@helix.local",
    displayName: "Sasha Okafor",
    title: "Engineering Lead",
    password: "sasha-pass",
  },
  {
    email: "priya@helix.local",
    displayName: "Priya Raman",
    title: "Product Designer",
    password: "priya-pass",
  },
  {
    email: "leo@helix.local",
    displayName: "Leo Whitfield",
    title: "Senior Engineer",
    password: "leo-pass",
  },
  {
    email: "nadia@helix.local",
    displayName: "Nadia Korhonen",
    title: "Security Lead",
    password: "nadia-pass",
  },
  {
    email: "maya@helix.local",
    displayName: "Maya Sharma",
    title: "Research Analyst",
    password: "maya-pass",
  },
  {
    email: "erica@helix.local",
    displayName: "Erica Johnson",
    title: "Finance Lead",
    password: "erica-pass",
  },
];

async function wipe(sql: postgres.Sql): Promise<void> {
  // We can't selectively delete-by-source because FK chains run deep
  // (objects → messages → threads → permissions → actors, etc.) and
  // many seed-created rows don't carry a `source` discriminator. For a
  // fresh dev workspace the safe thing is to TRUNCATE the entire
  // application data graph in one shot with CASCADE — everything seeded
  // and everything created by hand goes. The user explicitly asked for a
  // "full reseed", so this matches intent.
  process.stdout.write("Wiping all application data (TRUNCATE ... CASCADE)…\n");

  // Tables to truncate. Order doesn't matter under CASCADE, but listing
  // the heavy hitters first keeps the lock duration short. Anything that
  // a future migration adds will just stay as-is — we only touch the
  // tables we know about.
  const tables = [
    // Drive + objects graph
    "drive_versions",
    "objects",
    "drive_folders",
    // Native editor surfaces (will be dropped in a later cleanup)
    "docs_updates",
    "docs_comments",
    "docs_suggestions",
    "docs_documents",
    "sheet_cells",
    "sheet_tabs",
    "sheets",
    "slides",
    "slide_decks",
    // Threads + messages + mail + chat + calendar
    "messages",
    "threads",
    "mail_thread_state",
    "mail_labels",
    "mail_filters",
    "mail_vacation",
    "mail_vacation_responses",
    "mail_outbound_messages",
    "chat_pins",
    "chat_reactions",
    "chat_read_receipts",
    "chat_room_settings",
    "cal_calendar_memberships",
    "cal_calendars",
    "activity",
    "assistant_messages",
    // Permissions / seed registry / auth-mapping / agent stuff
    "permissions",
    "seed_corpus_assets",
    "pending_actions",
    "audit_log",
    "app_passwords",
    "agent_credentials",
    "access_tokens",
    "outbox",
    "outbound_webhooks_log",
    "search_index",
    "actor_memberships",
  ];
  for (const table of tables) {
    try {
      await sql.unsafe(`truncate table ${table} cascade`);
    } catch (error) {
      // Table may not exist on older dev DBs — log and continue.
      const msg = error instanceof Error ? error.message : String(error);
      process.stdout.write(`  · skip ${table}: ${msg.split("\n")[0] ?? ""}\n`);
    }
  }

  // Better-Auth login-mapping tables.
  //
  // CRITICAL: don't touch `user` or `session`. `session.userId` references
  // `user.id` with `ON DELETE CASCADE`, so any delete of a user row
  // cascades through and invalidates every active browser cookie. The
  // reseed below upserts users by stable id (derived from email), so
  // re-running reseed leaves sessions intact and the dev never gets
  // logged out unexpectedly.
  //
  // `account` IS wiped — credentials get re-hashed every reseed (in case
  // we change passwords or hash algorithm). The account row is keyed by
  // userId+providerId, so the recreate immediately re-links credentials
  // to the same stable user.
  for (const table of ['"account"', '"verification"']) {
    try {
      await sql.unsafe(`truncate table ${table} cascade`);
    } catch {
      /* schema differs across better-auth versions — fine */
    }
  }

  // Actors last (FK target for almost everything). The TRUNCATE CASCADE
  // above will have left them dangling — wipe just the @helix.local ones
  // so any system accounts (if present) survive.
  await sql`delete from actors where email like '%@helix.local'`;
}

async function ensureOrg(sql: postgres.Sql): Promise<string> {
  const rows = (await sql`
    select id
    from orgs
    where status = 'active'
    order by created_at
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] !== undefined) return rows[0].id;
  const id = randomUUID();
  await sql`
    insert into orgs (id, slug, display_name, status)
    values (${id}, ${`reseed-${id.slice(0, 8)}`}, 'Reseed workspace', 'active')
  `;
  return id;
}

async function reseedActors(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
): Promise<ReadonlyMap<string, string>> {
  process.stdout.write(
    `Creating ${String(PRINCIPALS.length)} principals with random UUIDs + login mappings…\n`,
  );
  const emailToActorId = new Map<string, string>();
  for (const principal of PRINCIPALS) {
    const actorId = randomUUID();
    emailToActorId.set(principal.email, actorId);
    const scopes: string[] = [...(principal.admin ? ADMIN_SCOPES : USER_SCOPES)];
    if (principal.password === undefined) {
      // Actor without a login — minimal metadata.
      await sql`
        insert into actors (id, org_id, type, email, display_name, scopes, metadata)
        values (
          ${actorId}, ${orgId}, 'user', ${principal.email}, ${principal.displayName},
          ${sql.array(scopes, 1009)},
          ${sql.json({ source: "reseed", title: principal.title ?? null })}
        )
      `;
      process.stdout.write(
        `  ${actorId.slice(0, 8)}… ${principal.email.padEnd(28)} ${principal.displayName}  (no login)\n`,
      );
      continue;
    }

    // Better-Auth user id is stable across reseeds. The provider link points
    // to the global subject while the replacement actor becomes its new
    // tenant-local membership.
    const userId = stableUserIdForEmail(principal.email);
    const passwordHash = await hashPassword(principal.password);
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes, metadata)
      values (
        ${actorId}, ${orgId}, 'user', ${principal.email}, ${principal.displayName},
        ${sql.array(scopes, 1009)},
        ${sql.json({ source: "reseed", title: principal.title ?? null })}
      )
    `;
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, ${principal.displayName}, ${principal.email}, true, now(), now())
      on conflict (id) do update set
        name = excluded.name,
        email = excluded.email,
        "emailVerified" = true,
        "updatedAt" = now()
    `;
    await sql`
      insert into account (
        id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt"
      ) values (
        ${`${userId}-credential`}, ${userId}, ${userId}, 'credential',
        ${passwordHash}, now(), now()
      )
    `;
    const linked = await sql<{ readonly actor_id: string | null }[]>`
      select helix_activate_identity_membership(
        'better-auth', ${userId}, ${orgId}, ${principal.email}, ${principal.displayName}
      ) as actor_id
    `;
    if (linked[0]?.actor_id !== actorId) {
      throw new Error(`Failed to link reseeded login ${principal.email}.`);
    }
    process.stdout.write(
      `  ${actorId.slice(0, 8)}… ${principal.email.padEnd(28)} ${principal.displayName}  (pw=${principal.password})\n`,
    );
  }
  return emailToActorId;
}

/** Run a child seed/backfill script and stream its output through. */
function runScript(scriptName: string): void {
  process.stdout.write(`\n→ ${scriptName}\n`);
  const result = spawnSync("pnpm", [scriptName], {
    stdio: "inherit",
    cwd: resolve(import.meta.dirname, "..", ".."),
  });
  if (result.status !== 0) {
    throw new Error(`${scriptName} exited with status ${String(result.status)}`);
  }
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    await wipe(sql);
    const orgId = await ensureOrg(sql);
    await withTenantPostgresContext(sql, { orgId }, (tx) => reseedActors(tx, orgId));
    process.stdout.write(`\nOrg id: ${orgId}\n\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  // db:seed:logins is INTENTIONALLY skipped — reseedActors above handles
  // the login mapping inline, using the random actor ids. Calling the
  // legacy seed would create a SECOND admin/user actor with the
  // hardcoded UUIDs and re-link Better-Auth to the wrong one.
  runScript("db:seed:corpus");
  runScript("db:backfill:empty-objects");
  // Mail / calendar / chat scenarios — gives every surface real content
  // tied to the random principal IDs.
  runScript("db:seed:scenarios");

  process.stdout.write("\n✓ Reseed complete. All entities now carry random UUIDs.\n");
  process.stdout.write("  Sign in: admin@helix.local / helix-admin-password (or user@…)\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `reseed FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

export { main as reseed };
