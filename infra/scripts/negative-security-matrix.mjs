#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const V2_PLAN_PATH =
  "docs/superpowers/plans/2026-07-28-core-workspace-production-readiness.md";

export const V2_NEGATIVE_SECURITY_MATRIX = [
  boundary("Tenant", "Org A ID/token cannot read or mutate Org B", [
    testCase(
      "tenant.cross_org_read_mutate",
      "An Org A actor remains unable to read, search, share, move, trash, or delete Org B data even when an Org B ACL row names that actor.",
      ref(
        "apps/helix/src/platform/tenancy/cross-tenant-isolation.test.ts",
        "does not expose beta Drive data to an acme actor even with beta permission rows",
        "live-postgres",
      ),
    ),
  ]),
  boundary("Mail", "unknown domain/mailbox; cross-org recipient metadata; external scope missing", [
    testCase(
      "mail.unknown_domain_mailbox",
      "SMTP recipient resolution fails closed for both an unknown receiving domain and an unknown local part without catch-all.",
      ref(
        "apps/helix/src/platform/mail/negative-security.test.ts",
        "rejects unknown receiving domains and unknown mailboxes without a catch-all",
      ),
    ),
    testCase(
      "mail.cross_org_recipient_metadata",
      "A receiving-domain record cannot bind cross-organization catch-all recipient metadata.",
      ref(
        "apps/helix/src/platform/mail/receiving-domains-store.test.ts",
        "rejects a catch-all actor outside the organization or disabled",
      ),
    ),
    testCase(
      "mail.external_scope_missing",
      "Every external To/Cc/reply recipient requires the composite mail.external scope.",
      ref(
        "apps/helix/src/platform/mail/mail.test.ts",
        "enforces the mail.external composite scope for external recipients",
      ),
    ),
  ]),
  boundary("Drive", "object ID guessing; quarantined file; revoked share/link; wrong KMS policy", [
    testCase(
      "drive.object_id_guessing",
      "An actor without an ACL receives the same not-found result when guessing an object ID.",
      ref(
        "apps/helix/src/platform/drive/store-authz.test.ts",
        "returns not_found to a stranger with no grant",
      ),
    ),
    testCase(
      "drive.quarantined_file",
      "A non-active/quarantined object cannot be listed, searched, downloaded, read by an agent, shared, or read through a public link.",
      ref(
        "apps/helix/src/platform/drive/availability-invariants.test.ts",
        "denies download, preview/agent reads, direct sharing, and public-link reads",
      ),
    ),
    testCase(
      "drive.revoked_share_link",
      "Unknown, revoked, and expired public links return the same non-enumerable 404.",
      ref(
        "apps/helix/src/platform/drive/routes.test.ts",
        "returns 404 for unknown/revoked/expired tokens",
      ),
    ),
    testCase(
      "drive.wrong_kms_policy",
      "Post-finalize encryption evidence using a different tenant KMS key is rejected.",
      ref(
        "apps/helix/src/platform/drive/storage-policy.test.ts",
        "rejects missing encryption and cross-tenant KMS evidence",
      ),
    ),
  ]),
  boundary("Chat", "non-member list/search/subscribe/send; wrong-origin valid cookie", [
    testCase(
      "chat.non_member_list_search_send",
      "A same-org non-member sees no rooms/search hits and cannot read or send room messages.",
      ref(
        "apps/helix/src/platform/chat/negative-security.test.ts",
        "keeps non-member room list and search empty and blocks message reads and sends",
      ),
    ),
    testCase(
      "chat.non_member_subscribe",
      "A same-org non-member cannot subscribe to room fan-out or presence.",
      ref(
        "apps/helix/src/platform/chat/realtime.test.ts",
        "rejects a non-member subscribe frame before fanout or presence",
      ),
    ),
    testCase(
      "chat.wrong_origin_cookie",
      "A valid browser session cookie does not bypass the exact WebSocket Origin allowlist.",
      ref(
        "apps/helix/src/platform/chat/realtime.test.ts",
        "rejects cross-site websocket hijacking with a valid session cookie",
      ),
    ),
  ]),
  boundary(
    "Agent",
    "hidden tool call; missing composite scope; self-approval; altered pending input",
    [
      testCase(
        "agent.hidden_tool_call",
        "A tool hidden from an actor by scope remains denied when called directly.",
        ref(
          "apps/helix/src/platform/tools/v2-negative-security.test.ts",
          "denies direct invocation of a tool hidden by the actor scope",
        ),
      ),
      testCase(
        "agent.missing_composite_scope",
        "A base tool scope cannot bypass a required conditional composite scope.",
        ref(
          "apps/helix/src/platform/tool-registry.test.ts",
          "enforces declared scope composition against the parsed call input",
        ),
      ),
      testCase(
        "agent.self_approval",
        "An agent cannot approve its own pending mutation.",
        ref(
          "apps/helix/src/platform/tools/registry.test.ts",
          "permits only the credential owner or a same-org human admin and never self-approval",
        ),
      ),
      testCase(
        "agent.altered_pending_input",
        "A pending action whose immutable input no longer matches its canonical hash cannot execute.",
        ref(
          "apps/helix/src/platform/tools/v2-negative-security.test.ts",
          "rejects altered pending input before an approved action executes",
        ),
      ),
    ],
  ),
  boundary("AI", "client lowers classification; restricted content sent to cloud provider", [
    testCase(
      "ai.client_lowers_classification",
      "A client-provided public classification cannot lower confidential server-derived context.",
      ref(
        "apps/helix/src/platform/ai/classification/effective.test.ts",
        "does not allow a public client hint to lower confidential server context",
      ),
    ),
    testCase(
      "ai.restricted_to_cloud",
      "Restricted content is not routed to an untagged cloud provider.",
      ref(
        "apps/helix/src/platform/ai/routing.test.ts",
        "reports unavailable provider when restricted requests have no local route",
      ),
      ref(
        "apps/helix/src/platform/ai/routing.test.ts",
        "never lets a disabled standard gate route confidential/restricted data to untagged cloud",
      ),
    ),
  ]),
  boundary("Auth", "expired/revoked/wrong-IP credential; CSRF/cross-origin", [
    testCase(
      "auth.expired_credential",
      "An expired credential is rejected.",
      ref("apps/helix/src/platform/auth/credentials.test.ts", "rejects an expired credential"),
    ),
    testCase(
      "auth.revoked_credential",
      "A revoked credential is rejected.",
      ref("apps/helix/src/platform/auth/credentials.test.ts", "rejects a revoked credential"),
    ),
    testCase(
      "auth.wrong_ip_credential",
      "A request IP outside the credential allowlist is rejected.",
      ref(
        "apps/helix/src/platform/auth/credentials.test.ts",
        "rejects an IP outside the allowlist",
      ),
    ),
    testCase(
      "auth.csrf_cross_origin",
      "A credentialed cross-origin mutation is rejected before its handler executes.",
      ref(
        "apps/helix/src/platform/security/origin-policy.test.ts",
        "rejects an evil credentialed origin before a mutating handler runs",
      ),
    ),
  ]),
  boundary("Webhook", "invalid signature, replay, wrong tenant, duplicate", [
    testCase(
      "webhook.invalid_signature",
      "Modified and expired signed provider payloads are rejected.",
      ref(
        "apps/helix/src/platform/mail/delivery-events.test.ts",
        "verifies exact raw bytes and rejects modified or expired payloads",
      ),
    ),
    testCase(
      "webhook.replay",
      "A replay of the same provider event is idempotent.",
      ref(
        "apps/helix/src/platform/mail/delivery-events.test.ts",
        "is durably idempotent and tenant/provider scoped",
      ),
    ),
    testCase(
      "webhook.wrong_tenant",
      "Provider events cannot resolve or update another tenant's outbound record.",
      ref(
        "apps/helix/src/platform/mail/delivery-events.test.ts",
        "is durably idempotent and tenant/provider scoped",
      ),
    ),
    testCase(
      "webhook.duplicate",
      "Duplicate delivery events do not create a second domain event.",
      ref(
        "apps/helix/src/platform/mail/delivery-events.test.ts",
        "is durably idempotent and tenant/provider scoped",
      ),
    ),
  ]),
  boundary("Audit", "sink failure on critical action; hash-chain tamper", [
    testCase(
      "audit.critical_sink_failure",
      "A critical pending action fails closed when its audit outcome cannot persist.",
      ref(
        "apps/helix/src/platform/tool-registry.test.ts",
        "fails closed and cancels a pending action when its audit cannot persist",
      ),
    ),
    testCase(
      "audit.hash_chain_tamper",
      "Payload or previous-link tampering is detected by hash-chain verification.",
      ref(
        "apps/helix/src/platform/audit/hash.test.ts",
        "reports a record whose stored hash no longer matches its payload",
      ),
      ref("apps/helix/src/platform/audit/hash.test.ts", "reports a broken previous-hash link"),
    ),
  ]),
  boundary("Backup", "missing key, corrupted archive, object/DB mismatch", [
    testCase(
      "backup.missing_key",
      "A Business backup without encryption/key-custody controls fails closed.",
      ref(
        "infra/scripts/backup-manifest.test.mjs",
        "fails closed when a production backup omits resilience or key-custody controls",
      ),
    ),
    testCase(
      "backup.corrupted_archive",
      "A checksummed backup artifact modified after capture is rejected before restore.",
      ref("infra/scripts/backup-manifest.test.mjs", "detects artifact tampering before restore"),
    ),
    testCase(
      "backup.object_db_mismatch",
      "A restore report cannot pass when sampled object hashes do not match the database recovery set.",
      ref(
        "infra/scripts/restore-drill-evidence.test.mjs",
        "does not claim success for plaintext, shared-target, stale, slow, or incomplete drills",
      ),
    ),
  ]),
];

const EXPECTED_BOUNDARIES = [
  "Tenant",
  "Mail",
  "Drive",
  "Chat",
  "Agent",
  "AI",
  "Auth",
  "Webhook",
  "Audit",
  "Backup",
];

export async function validateNegativeSecurityMatrix(root = process.cwd()) {
  if (V2_NEGATIVE_SECURITY_MATRIX.length !== EXPECTED_BOUNDARIES.length) {
    throw new Error("V2 matrix boundary count does not match the plan.");
  }
  const names = V2_NEGATIVE_SECURITY_MATRIX.map(({ boundary: name }) => name);
  if (new Set(names).size !== names.length || names.join("|") !== EXPECTED_BOUNDARIES.join("|")) {
    throw new Error("V2 matrix boundaries are missing, duplicated, or out of plan order.");
  }

  const plan = await readFile(resolve(root, V2_PLAN_PATH), "utf8");
  const seenCaseIds = new Set();
  const sourceCache = new Map();
  for (const row of V2_NEGATIVE_SECURITY_MATRIX) {
    const planRow = new RegExp(
      `^\\|\\s*${escapeRegExp(row.boundary)}\\s*\\|\\s*${escapeRegExp(row.planRequirement)}\\s*\\|$`,
      "mu",
    );
    if (!planRow.test(plan)) {
      throw new Error(`V2 ${row.boundary} requirement drifted from ${V2_PLAN_PATH}.`);
    }
    if (row.cases.length === 0) {
      throw new Error(`V2 ${row.boundary} has no automated cases.`);
    }
    for (const entry of row.cases) {
      if (!/^[a-z]+(?:[._][a-z0-9]+)+$/u.test(entry.id) || seenCaseIds.has(entry.id)) {
        throw new Error(`V2 case id is invalid or duplicated: ${entry.id}.`);
      }
      seenCaseIds.add(entry.id);
      if (entry.tests.length === 0) {
        throw new Error(`V2 case ${entry.id} has no automated test reference.`);
      }
      for (const test of entry.tests) {
        if (!/\.test\.(?:ts|tsx|mjs)$/u.test(test.file)) {
          throw new Error(`V2 case ${entry.id} references a non-test file: ${test.file}.`);
        }
        let source = sourceCache.get(test.file);
        if (source === undefined) {
          source = await readFile(resolve(root, test.file), "utf8");
          sourceCache.set(test.file, source);
        }
        if (!source.includes(test.title)) {
          throw new Error(`V2 case ${entry.id} test selector is missing: ${test.title}.`);
        }
      }
    }
  }
  return V2_NEGATIVE_SECURITY_MATRIX;
}

export function negativeSecurityCommands(matrix = V2_NEGATIVE_SECURITY_MATRIX) {
  const commands = new Map();
  for (const row of matrix) {
    for (const entry of row.cases) {
      for (const test of entry.tests) {
        const key = `${test.file}\0${test.title}\0${test.execution}`;
        const appPrefix = "apps/helix/";
        const command = test.file.startsWith(appPrefix)
          ? `pnpm --filter @helix/app exec vitest run ${shellQuote(
              test.file.slice(appPrefix.length),
            )} -t ${shellQuote(test.title)}`
          : `pnpm exec vitest run ${shellQuote(test.file)} -t ${shellQuote(test.title)}`;
        commands.set(key, {
          execution: test.execution,
          command,
          ...(test.execution === "live-postgres" ? { requiredEnvironment: ["DATABASE_URL"] } : {}),
        });
      }
    }
  }
  return [...commands.values()];
}

function boundary(name, planRequirement, cases) {
  return { boundary: name, planRequirement, cases };
}

function testCase(id, assertion, ...tests) {
  return { id, assertion, tests };
}

function ref(file, title, execution = "default") {
  return { file, title, execution };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function main() {
  const matrix = await validateNegativeSecurityMatrix();
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "helix.v2-negative-security-matrix.v1",
        status: "mapped",
        note: "Mapped means requirement/test selectors were validated; it is not test-run evidence.",
        plan: V2_PLAN_PATH,
        rows: matrix,
        commands: negativeSecurityCommands(matrix),
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `negative-security matrix validation failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
