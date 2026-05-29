#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const usage = `Usage: infra/scripts/synthetic-signup-probe.mjs [--static]

Runs a live synthetic signup activation probe against a SaaS-mode Helix stack:
create workspace -> poll test mailbox for verification link -> verify email ->
measure activation latency.

Environment:
  HELIX_BASE_URL                         Default: http://127.0.0.1:28431
  HELIX_SYNTHETIC_SIGNUP_MAILPIT_URL     Default: http://127.0.0.1:28458
  HELIX_SYNTHETIC_SIGNUP_EMAIL_DOMAIN    Default: synthetic.helix.local
  HELIX_SYNTHETIC_SIGNUP_ORG_PREFIX      Default: synth
  HELIX_SYNTHETIC_SIGNUP_COUNTRY         Default: US
  HELIX_SYNTHETIC_SIGNUP_RECAPTCHA_TOKEN Optional token if reCAPTCHA is enabled
  HELIX_SYNTHETIC_SIGNUP_TIMEOUT_MS      Default: 60000
  HELIX_SYNTHETIC_SIGNUP_THRESHOLD_MS    Default: 60000
  HELIX_SYNTHETIC_SIGNUP_OUTPUT          Optional JSON evidence output path
`;

if (isMain()) {
  await main();
}

async function main() {
  const staticOnly = process.argv.includes("--static");
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    process.stdout.write(usage);
    process.exit(0);
  }
  if (staticOnly) {
    validateStaticEnvironmentNames();
    process.stdout.write("synthetic signup probe static validation complete\n");
    process.exit(0);
  }

  const evidence = await runSyntheticSignupProbe();
  const outputPath = process.env.HELIX_SYNTHETIC_SIGNUP_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status !== "passed") {
    process.exit(1);
  }
}

async function runSyntheticSignupProbe() {
  const startedAt = Date.now();
  const config = {
    baseUrl: env("HELIX_BASE_URL", "http://127.0.0.1:28431"),
    mailpitUrl: env("HELIX_SYNTHETIC_SIGNUP_MAILPIT_URL", "http://127.0.0.1:28458"),
    emailDomain: env("HELIX_SYNTHETIC_SIGNUP_EMAIL_DOMAIN", "synthetic.helix.local"),
    orgPrefix: env("HELIX_SYNTHETIC_SIGNUP_ORG_PREFIX", "synth"),
    country: env("HELIX_SYNTHETIC_SIGNUP_COUNTRY", "US"),
    recaptchaToken: optionalEnv("HELIX_SYNTHETIC_SIGNUP_RECAPTCHA_TOKEN"),
    timeoutMs: positiveIntEnv("HELIX_SYNTHETIC_SIGNUP_TIMEOUT_MS", 60_000),
    thresholdMs: positiveIntEnv("HELIX_SYNTHETIC_SIGNUP_THRESHOLD_MS", 60_000),
  };

  const suffix = syntheticSuffix(startedAt);
  const input = {
    email: `signup-${suffix}@${config.emailDomain}`,
    password: `Helix synthetic ${suffix} passphrase`,
    orgName: `Helix Synthetic ${suffix}`,
    orgSlug: `${slugify(config.orgPrefix)}-${suffix}`,
    country: config.country.toUpperCase(),
    marketingOptIn: false,
    termsAccepted: true,
    privacyAccepted: true,
    ...(config.recaptchaToken === undefined ? {} : { recaptchaToken: config.recaptchaToken }),
  };

  await submitSignup(config.baseUrl, input);
  const verification = await waitForVerificationLink({
    mailpitUrl: config.mailpitUrl,
    orgSlug: input.orgSlug,
    recipient: input.email,
    timeoutMs: config.timeoutMs,
  });
  const verifyResult = await verifyEmailWithRetry({
    baseUrl: config.baseUrl,
    token: verification.token,
    timeoutMs: Math.max(1, config.timeoutMs - (Date.now() - startedAt)),
  });

  const completedAt = Date.now();
  const latencyMs = completedAt - startedAt;
  return {
    status: latencyMs <= config.thresholdMs ? "passed" : "threshold_exceeded",
    baseUrl: config.baseUrl,
    mailpitUrl: config.mailpitUrl,
    orgSlug: input.orgSlug,
    verificationMessageId: verification.messageId,
    verificationAttempts: verifyResult.attempts,
    sessionCreated: verifyResult.sessionCreated,
    activationStatus: verifyResult.status,
    latencyMs,
    thresholdMs: config.thresholdMs,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
  };
}

async function submitSignup(baseUrl, body) {
  const response = await fetch(new URL("/api/signup", baseUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await readJsonResponse(response, "signup");
  if (response.status !== 202 || parsed?.status !== "provisioning") {
    throw new Error(
      `signup did not start provisioning: HTTP ${response.status} ${JSON.stringify(parsed)}`,
    );
  }
  if (parsed?.verification?.status !== "pending") {
    throw new Error(
      `signup response did not request email verification: ${JSON.stringify(parsed)}`,
    );
  }
}

async function waitForVerificationLink({ mailpitUrl, orgSlug, recipient, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const message = await findMailpitVerificationMessage(mailpitUrl, orgSlug, recipient);
      if (message !== null) {
        return message;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  const suffix = lastError instanceof Error ? ` Last Mailpit error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for signup verification email for ${orgSlug}.${suffix}`);
}

async function findMailpitVerificationMessage(mailpitUrl, orgSlug, recipient) {
  const listResponse = await fetch(new URL("/api/v1/messages", mailpitUrl), {
    headers: { accept: "application/json" },
  });
  const list = await readJsonResponse(listResponse, "Mailpit messages");
  if (!listResponse.ok) {
    throw new Error(
      `Mailpit messages returned HTTP ${listResponse.status}: ${JSON.stringify(list)}`,
    );
  }
  const messages = Array.isArray(list?.messages) ? list.messages : [];
  for (const summary of messages) {
    if (!mailpitSummaryMatches(summary, orgSlug, recipient)) {
      continue;
    }
    const id = messageIdFromSummary(summary);
    if (id === null) {
      continue;
    }
    const detail = await getMailpitMessage(mailpitUrl, id);
    const text = JSON.stringify(detail);
    if (!text.includes(orgSlug) || !text.includes(recipient)) {
      continue;
    }
    const token = extractVerificationToken(text);
    if (token !== null) {
      return { messageId: id, token };
    }
  }
  return null;
}

async function getMailpitMessage(mailpitUrl, id) {
  const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(id)}`, mailpitUrl), {
    headers: { accept: "application/json" },
  });
  const parsed = await readJsonResponse(response, "Mailpit message");
  if (!response.ok) {
    throw new Error(
      `Mailpit message ${id} returned HTTP ${response.status}: ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

async function verifyEmailWithRetry({ baseUrl, token, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last;
  while (Date.now() < deadline) {
    attempts += 1;
    const response = await fetch(new URL("/api/signup/verify-email", baseUrl), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const parsed = await readJsonResponse(response, "signup verify email");
    if (response.ok && parsed?.status === "active" && parsed?.verification?.status === "verified") {
      return {
        status: parsed.status,
        sessionCreated: parsed?.session?.created === true,
        attempts,
      };
    }
    last = parsed;
    if (response.status !== 409 || parsed?.error?.code !== "tenant_not_ready") {
      throw new Error(`signup verify failed: HTTP ${response.status} ${JSON.stringify(parsed)}`);
    }
    await sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for signup verification to activate. Last response: ${JSON.stringify(last)}`,
  );
}

function mailpitSummaryMatches(summary, orgSlug, recipient) {
  const text = JSON.stringify(summary);
  return text.includes(`Verify ${orgSlug}`) && text.includes(recipient);
}

function messageIdFromSummary(summary) {
  for (const key of ["ID", "Id", "id"]) {
    const value = summary?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function extractVerificationToken(text) {
  const match = text.match(/\/signup\/verify-email\?token=([^"'\\\s<>]+)/u);
  if (match?.[1] === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(match[1].replaceAll("&amp;", "&"));
  } catch {
    return match[1];
  }
}

export function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .replaceAll(/-+/gu, "-")
    .slice(0, 24);
  return slug.length === 0 ? "synth" : slug;
}

function syntheticSuffix(nowMs) {
  return `${new Date(nowMs).toISOString().replaceAll(/[-:.]/gu, "").slice(0, 15).toLowerCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function readJsonResponse(response, action) {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${action} returned non-JSON response: ${text.slice(0, 200)}`, {
      cause: error,
    });
  }
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateStaticEnvironmentNames() {
  for (const name of [
    "HELIX_BASE_URL",
    "HELIX_SYNTHETIC_SIGNUP_MAILPIT_URL",
    "HELIX_SYNTHETIC_SIGNUP_EMAIL_DOMAIN",
    "HELIX_SYNTHETIC_SIGNUP_ORG_PREFIX",
    "HELIX_SYNTHETIC_SIGNUP_COUNTRY",
    "HELIX_SYNTHETIC_SIGNUP_RECAPTCHA_TOKEN",
    "HELIX_SYNTHETIC_SIGNUP_TIMEOUT_MS",
    "HELIX_SYNTHETIC_SIGNUP_THRESHOLD_MS",
    "HELIX_SYNTHETIC_SIGNUP_OUTPUT",
  ]) {
    if (!/^HELIX_[A-Z0-9_]+$/u.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}
