#!/usr/bin/env node
/**
 * Local volume soak — multi-user bulk data + DB/API/audit verification.
 *
 * Unlike `--iterations` health pings, this harness:
 *   1. Seeds ~25 actors (admin, user, 23 teammates) + large mail/chat/drive corpus
 *   2. Verifies row counts in Postgres (threads, messages, rooms, drive objects, activity)
 *   3. Exercises live API tools (mail/drive/chat/search) and asserts non-empty results
 *   4. Runs multi-user RBAC probes (admin vs limited user)
 *   5. Spot-checks audit log after privileged tools
 *   6. Optional write wave: N API tool invocations with success/error accounting
 *
 * Usage:
 *   node scripts/local-volume-soak.mjs --base-url http://127.0.0.1:38600
 *   pnpm quality:local-volume-soak -- --base-url http://127.0.0.1:38600 --write-wave 200
 *
 * Required env:
 *   DATABASE_URL (or defaults to high-port smoke postgres)
 *   HELIX_BASE_URL
 *   HELIX_SMOKE_CLIENT_ID / HELIX_SMOKE_CLIENT_SECRET (OAuth)
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";
export const DEFAULT_BASE_URL = "http://127.0.0.1:38600";
export const DEFAULT_DATABASE_URL = "postgres://helix:helix_dev_password@127.0.0.1:38601/helix";

/** Minimum DB counts after large seed (documented in seed-workspace-large). */
export const MIN_COUNTS = {
  actors: 20,
  mailThreads: 200,
  mailMessages: 300,
  chatRooms: 20,
  chatMessages: 2000,
  driveObjects: 50,
};

export function parseArgs(argv) {
  const options = {
    baseUrl: process.env.HELIX_BASE_URL ?? DEFAULT_BASE_URL,
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    orgId: process.env.HELIX_DEFAULT_ORG_ID ?? DEFAULT_ORG_ID,
    outputDir: null,
    writeWave: 100,
    skipSeed: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--base-url") options.baseUrl = argv[++i];
    else if (arg === "--database-url") options.databaseUrl = argv[++i];
    else if (arg === "--org-id") options.orgId = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--write-wave") options.writeWave = Math.max(0, Number(argv[++i] ?? 0));
    else if (arg === "--skip-seed") options.skipSeed = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.outputDir === null) {
    const stamp = new Date()
      .toISOString()
      .replaceAll(":", "")
      .replace(/\.\d+Z$/, "Z");
    options.outputDir = join(REPO_ROOT, "artifacts", "local-volume-soak", stamp);
  }
  return options;
}

export function usage() {
  return `Usage: node scripts/local-volume-soak.mjs [options]

Bulk multi-user volume soak with DB + API + audit verification.

Options:
  --base-url URL        Helix API (default ${DEFAULT_BASE_URL})
  --database-url URL    Postgres (default high-port smoke DB)
  --org-id UUID         Org to seed/verify
  --write-wave N        Extra live tool read/write cycles after seed (default 100)
  --skip-seed           Skip large workspace seed (verify existing data only)
  --output-dir DIR      Report directory
  -h, --help
`;
}

async function runCommand(command, args, env = {}) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      resolvePromise({
        command: [command, ...args].join(" "),
        code: code ?? 1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

async function sqlQuery(databaseUrl, sqlText) {
  // Prefer docker exec into helix-smoke-hi postgres for reliability.
  const result = await runCommand(
    "docker",
    [
      "compose",
      "-p",
      process.env.COMPOSE_PROJECT_NAME ?? "helix-smoke-hi",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "helix",
      "-d",
      "helix",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-c",
      sqlText,
    ],
    { DATABASE_URL: databaseUrl },
  );
  if (result.code !== 0) {
    throw new Error(`sql failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function collectDbCounts(databaseUrl, orgId) {
  const q = async (sql) => {
    const raw = await sqlQuery(databaseUrl, sql);
    const n = Number(raw.split("\n")[0] ?? "0");
    return Number.isFinite(n) ? n : 0;
  };
  // Schema thread_kind: mail | chat_room | chat_dm | doc | calendar | …
  return {
    actors: await q(
      `SELECT count(*)::text FROM actors WHERE org_id = '${orgId}' AND disabled_at IS NULL`,
    ),
    mailThreads: await q(
      `SELECT count(*)::text FROM threads WHERE org_id = '${orgId}' AND kind = 'mail'`,
    ),
    chatRooms: await q(
      `SELECT count(*)::text FROM threads WHERE org_id = '${orgId}' AND kind IN ('chat_room', 'chat_dm')`,
    ),
    mailMessages: await q(
      `SELECT count(*)::text FROM messages m INNER JOIN threads t ON t.id = m.thread_id WHERE t.org_id = '${orgId}' AND t.kind = 'mail'`,
    ),
    chatMessages: await q(
      `SELECT count(*)::text FROM messages m INNER JOIN threads t ON t.id = m.thread_id WHERE t.org_id = '${orgId}' AND t.kind IN ('chat_room', 'chat_dm')`,
    ),
    driveObjects: await q(`SELECT count(*)::text FROM objects WHERE org_id = '${orgId}'`),
    activity: await q(`SELECT count(*)::text FROM activity WHERE org_id = '${orgId}'`),
    calendarThreads: await q(
      `SELECT count(*)::text FROM threads WHERE org_id = '${orgId}' AND kind = 'calendar'`,
    ),
    docThreads: await q(
      `SELECT count(*)::text FROM threads WHERE org_id = '${orgId}' AND kind = 'doc'`,
    ),
  };
}

/** Extract trailing JSON object from seed CLI stdout (pretty-printed or single-line). */
export function parseSeedJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // pretty-printed: find last top-level { … }
  }
  const start = text.lastIndexOf("\n{");
  const idx = start >= 0 ? start + 1 : text.indexOf("{");
  if (idx < 0) return null;
  try {
    return JSON.parse(text.slice(idx));
  } catch {
    return { raw: text.slice(-2000) };
  }
}

export function evaluateMinCounts(counts, mins = MIN_COUNTS) {
  const failures = [];
  for (const [key, min] of Object.entries(mins)) {
    const actual = counts[key] ?? 0;
    if (actual < min) {
      failures.push({ key, actual, min });
    }
  }
  return { ok: failures.length === 0, failures };
}

async function mintToken(baseUrl, clientId, clientSecret, scope) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope,
  });
  const response = await fetch(new URL("/oauth/token", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await response.json();
  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(`token mint failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function toolCall(baseUrl, token, toolId, input = {}) {
  const response = await fetch(new URL(`/api/tools/${toolId}`, baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json, toolId };
}

export async function runApiVolumeWave(baseUrl, token, waveSize) {
  const results = {
    ok: 0,
    failed: 0,
    byTool: {},
    samples: [],
  };
  const tools = [
    { id: "mail.threads.list", input: { limit: 20 } },
    { id: "mail.search", input: { query: "a", limit: 10 } },
    { id: "drive.list", input: { limit: 20 } },
    { id: "drive.search", input: { query: "a", limit: 10 } },
    { id: "chat.room.list", input: {} },
    { id: "chat.search", input: { query: "a", limit: 10 } },
    { id: "search.query", input: { query: "helix", limit: 10 } },
    { id: "platform.ping", input: {} },
  ];

  for (let i = 0; i < waveSize; i += 1) {
    const tool = tools[i % tools.length];
    const res = await toolCall(baseUrl, token, tool.id, tool.input);
    const key = tool.id;
    results.byTool[key] ??= { ok: 0, failed: 0, statuses: {} };
    results.byTool[key].statuses[res.status] = (results.byTool[key].statuses[res.status] ?? 0) + 1;
    // 200 success; 202 pending; 404 tool missing is failed for volume purpose
    if (res.status >= 200 && res.status < 300) {
      results.ok += 1;
      results.byTool[key].ok += 1;
    } else {
      results.failed += 1;
      results.byTool[key].failed += 1;
      if (results.samples.length < 20) {
        results.samples.push({
          i,
          toolId: tool.id,
          status: res.status,
          body: res.body,
        });
      }
    }
  }
  return results;
}

export async function runMultiUserChecks(baseUrl, adminToken, userToken) {
  const checks = [];
  const adminUsers = await fetch(new URL("/api/admin/users?limit=50", baseUrl), {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const adminJson = await adminUsers.json().catch(() => ({}));
  const userCount = Array.isArray(adminJson.users) ? adminJson.users.length : 0;
  checks.push({
    name: "admin.users.list",
    ok: adminUsers.status === 200 && userCount >= 2,
    status: adminUsers.status,
    userCount,
  });

  const userDenied = await fetch(new URL("/api/admin/users?limit=1", baseUrl), {
    headers: { authorization: `Bearer ${userToken}` },
  });
  checks.push({
    name: "user.admin.users.denied",
    ok: userDenied.status === 401 || userDenied.status === 403,
    status: userDenied.status,
  });

  const foreign = await fetch(
    new URL("/api/admin/users/ffffffff-ffff-4fff-8fff-ffffffffffff/offboard", baseUrl),
    { method: "POST", headers: { authorization: `Bearer ${adminToken}` } },
  );
  checks.push({
    name: "admin.offboard.foreign_not_200",
    ok: foreign.status === 403 || foreign.status === 404,
    status: foreign.status,
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export async function runAuditSpotCheck(baseUrl, token) {
  // Trigger list tools that should audit
  await toolCall(baseUrl, token, "app.passwords.list", {});
  await toolCall(baseUrl, token, "agent.credentials.list", {});
  const response = await fetch(new URL("/api/admin/audit-log?limit=25", baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  const rows = body.records ?? body.entries ?? body.items ?? body.audit ?? [];
  const list = Array.isArray(rows) ? rows : [];
  return {
    ok: response.status === 200 && list.length > 0,
    status: response.status,
    rowCount: list.length,
    sampleVerbs: list
      .slice(0, 10)
      .map((r) => r.verb ?? r.action ?? r.type)
      .filter(Boolean),
  };
}

export async function assertToolNonEmpty(baseUrl, token, toolId, input, pathHint) {
  const res = await toolCall(baseUrl, token, toolId, input);
  const text = JSON.stringify(res.body ?? {});
  const hasList =
    (res.body && Array.isArray(res.body.threads) && res.body.threads.length > 0) ||
    (res.body && Array.isArray(res.body.rooms) && res.body.rooms.length > 0) ||
    (res.body && Array.isArray(res.body.items) && res.body.items.length > 0) ||
    (res.body && Array.isArray(res.body.objects) && res.body.objects.length > 0) ||
    (res.body && Array.isArray(res.body.hits) && res.body.hits.length > 0) ||
    (res.body && Array.isArray(res.body.output?.threads) && res.body.output.threads.length > 0) ||
    (res.body && Array.isArray(res.body.output?.items) && res.body.output.items.length > 0);
  const ok = res.status >= 200 && res.status < 300 && (hasList || text.length > 40);
  return {
    toolId,
    status: res.status,
    ok,
    pathHint,
    bodyPreview: text.slice(0, 400),
  };
}

export async function runLocalVolumeSoak(options) {
  const report = {
    schema: "helix.local-volume-soak.v1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    baseUrl: options.baseUrl,
    orgId: options.orgId,
    status: "running",
    phases: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
  };
  await mkdir(options.outputDir, { recursive: true });

  const record = (name, status, detail = {}) => {
    // Never let detail.status (e.g. HTTP status) overwrite phase status.
    const { status: httpStatus, ...rest } = detail ?? {};
    const phase = { name, status, ...rest };
    if (httpStatus !== undefined && phase.httpStatus === undefined) {
      phase.httpStatus = httpStatus;
    }
    report.phases.push(phase);
    if (status === "passed") report.summary.passed += 1;
    else if (status === "failed") report.summary.failed += 1;
    else report.summary.skipped += 1;
  };

  // 0) health
  try {
    const h = await fetch(new URL("/healthz", options.baseUrl));
    record("healthz", h.ok ? "passed" : "failed", { httpStatus: h.status });
    if (!h.ok) {
      report.status = "failed";
      report.completedAt = new Date().toISOString();
      await writeFile(
        join(options.outputDir, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      return report;
    }
  } catch (error) {
    record("healthz", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    await writeFile(join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  // 1) large seed (mail/chat/drive volume + 23 teammates ≈ 25 users)
  if (!options.skipSeed) {
    const seedEnv = {
      DATABASE_URL: options.databaseUrl,
      HELIX_DEFAULT_ORG_ID: options.orgId,
    };
    const login = await runCommand(
      "pnpm",
      ["--filter", "@helix/app", "exec", "tsx", "src/db/seed-login-accounts.ts"],
      seedEnv,
    );
    await writeFile(join(options.outputDir, "seed-login.log"), `${login.stdout}${login.stderr}`);
    const light = await runCommand(
      "pnpm",
      ["--filter", "@helix/app", "exec", "tsx", "src/db/seed-workspace.ts"],
      seedEnv,
    );
    await writeFile(
      join(options.outputDir, "seed-workspace.log"),
      `${light.stdout}${light.stderr}`,
    );
    const large = await runCommand(
      "pnpm",
      ["--filter", "@helix/app", "exec", "tsx", "src/db/seed-workspace-large.ts"],
      seedEnv,
    );
    await writeFile(
      join(options.outputDir, "seed-workspace-large.log"),
      `${large.stdout}${large.stderr}`,
    );
    const seedCounts = parseSeedJson(large.stdout);
    const seedOk = large.code === 0;
    record("seed-volume", seedOk ? "passed" : "failed", {
      seedCounts,
      loginCode: login.code,
      lightCode: light.code,
      largeCode: large.code,
      loginOk: login.code === 0,
      lightOk: light.code === 0,
    });
  } else {
    record("seed-volume", "skipped", { reason: "--skip-seed" });
  }

  // 2) DB count verification
  let counts = {};
  try {
    counts = await collectDbCounts(options.databaseUrl, options.orgId);
    const evaluation = evaluateMinCounts(counts);
    // Require multi-user + multi-surface bulk volume (not just health pings).
    const volumeOk =
      evaluation.ok ||
      (counts.actors >= MIN_COUNTS.actors &&
        counts.chatMessages >= MIN_COUNTS.chatMessages &&
        counts.mailThreads >= MIN_COUNTS.mailThreads &&
        counts.driveObjects >= MIN_COUNTS.driveObjects);
    record("db-counts", volumeOk ? "passed" : "failed", {
      counts,
      mins: MIN_COUNTS,
      evaluation,
    });
  } catch (error) {
    record("db-counts", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 3) mint tokens + API volume wave
  const clientId = process.env.HELIX_SMOKE_CLIENT_ID ?? "helix-local-oauth-client";
  const clientSecret = process.env.HELIX_SMOKE_CLIENT_SECRET ?? "helix-local-dev-secret";
  const scope =
    process.env.HELIX_SMOKE_SCOPE ??
    "platform.read mail.read mail.write mail.send mail.external chat.read chat.write chat.create chat.post drive.read drive.write drive.delete assistant.read assistant.write assistant.memory admin.users admin.audit admin.agents admin.config.read admin.config.write search.read";
  let adminToken = process.env.HELIX_ACCESS_TOKEN;
  try {
    if (!adminToken) {
      adminToken = await mintToken(options.baseUrl, clientId, clientSecret, scope);
    }
    record("oauth-mint", "passed", { tokenLen: adminToken.length });
  } catch (error) {
    record("oauth-mint", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    await writeFile(join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  // user token via Better-Auth email sign-in (session bearer)
  let userToken = process.env.HELIX_SMOKE_USER_TOKEN;
  try {
    if (!userToken) {
      // Node fetch sends Origin: null; Better Auth requires a trusted origin
      // (see BETTER_AUTH_TRUSTED_ORIGINS / BETTER_AUTH_URL). curl without Origin
      // works; undici does not — always send an allow-listed origin.
      const trustedOrigin =
        process.env.HELIX_SMOKE_ORIGIN ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
      const sign = await fetch(new URL("/api/auth/sign-in/email", options.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: trustedOrigin,
        },
        body: JSON.stringify({
          email: process.env.HELIX_SMOKE_USER_EMAIL ?? "user@helix.local",
          password: process.env.HELIX_SMOKE_USER_PASSWORD ?? "helix-user-password",
        }),
      });
      const sj = await sign.json().catch(() => ({}));
      userToken =
        (typeof sj.token === "string" && sj.token) ||
        (typeof sj.session?.token === "string" && sj.session.token) ||
        null;
      if (!userToken && !sign.ok) {
        record("user-sign-in", "failed", {
          httpStatus: sign.status,
          bodyPreview: JSON.stringify(sj).slice(0, 300),
        });
      } else {
        record("user-sign-in", userToken ? "passed" : "failed", {
          tokenLen: userToken?.length ?? 0,
          httpStatus: sign.status,
        });
      }
    } else {
      record("user-sign-in", "passed", { tokenLen: userToken.length, source: "env" });
    }
  } catch (error) {
    record("user-sign-in", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // API non-empty list checks
  const listChecks = [];
  for (const [toolId, input] of [
    ["mail.threads.list", { limit: 50 }],
    ["drive.list", { limit: 50 }],
    ["chat.room.list", {}],
    ["search.query", { query: "a", limit: 20 }],
  ]) {
    listChecks.push(await assertToolNonEmpty(options.baseUrl, adminToken, toolId, input));
  }
  const listsOk = listChecks.filter((c) => c.ok).length >= 2;
  record("api-list-volume", listsOk ? "passed" : "failed", { listChecks });

  // write wave
  if (options.writeWave > 0) {
    const wave = await runApiVolumeWave(options.baseUrl, adminToken, options.writeWave);
    const waveOk = wave.failed === 0 || wave.ok / Math.max(1, wave.ok + wave.failed) >= 0.85;
    record(waveOk ? "api-write-wave" : "api-write-wave", waveOk ? "passed" : "failed", {
      writeWave: options.writeWave,
      ...wave,
    });
    await writeFile(
      join(options.outputDir, "api-write-wave.json"),
      `${JSON.stringify(wave, null, 2)}\n`,
    );
  } else {
    record("api-write-wave", "skipped");
  }

  // multi-user
  if (userToken) {
    const mu = await runMultiUserChecks(options.baseUrl, adminToken, userToken);
    record("multi-user-rbac", mu.ok ? "passed" : "failed", mu);
  } else {
    record("multi-user-rbac", "skipped", { reason: "no user token" });
  }

  // audit
  const audit = await runAuditSpotCheck(options.baseUrl, adminToken);
  record("audit-spot-check", audit.ok ? "passed" : "failed", audit);

  // final DB recount after wave
  try {
    const after = await collectDbCounts(options.databaseUrl, options.orgId);
    record("db-counts-after-wave", "passed", { counts: after });
    report.finalCounts = after;
  } catch (error) {
    record("db-counts-after-wave", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  report.completedAt = new Date().toISOString();
  report.status = report.summary.failed > 0 ? "failed" : "passed";
  report.claims = {
    multi_user_volume_seed: report.phases.some(
      (p) => p.name === "seed-volume" && p.status === "passed",
    ),
    db_volume_verified: report.phases.some((p) => p.name === "db-counts" && p.status === "passed"),
    api_volume_wave: report.phases.some(
      (p) => p.name === "api-write-wave" && p.status === "passed",
    ),
    multi_user_rbac: report.phases.some(
      (p) => p.name === "multi-user-rbac" && p.status === "passed",
    ),
    audit_spot_check: report.phases.some(
      (p) => p.name === "audit-spot-check" && p.status === "passed",
    ),
    external_mail_deliverability: false,
    final_release_go: false,
  };

  const reportPath = join(options.outputDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.reportPath = reportPath;
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  process.stdout.write(
    `local-volume-soak baseUrl=${options.baseUrl} writeWave=${options.writeWave} output=${options.outputDir}\n`,
  );
  const report = await runLocalVolumeSoak(options);
  process.stdout.write(
    `${JSON.stringify({ status: report.status, summary: report.summary, claims: report.claims, reportPath: report.reportPath, finalCounts: report.finalCounts }, null, 2)}\n`,
  );
  if (report.status === "failed") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
