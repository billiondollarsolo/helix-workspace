#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve4, resolve6, resolveMx, resolveTxt, reverse } from "node:dns/promises";
import { spawnSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const paths = {
  compose: "infra/mail-edge/compose.yaml",
  postfix: "infra/mail-edge/config/postfix-main.cf",
  patch: "infra/mail-edge/config/user-patches.sh",
  ratelimit: "infra/mail-edge/config/rspamd/override.d/ratelimit.conf",
  readme: "infra/mail-edge/README.md",
};
const files = Object.fromEntries(
  await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [
      key,
      await readFile(new URL(path, root), "utf8"),
    ]),
  ),
);

const required = {
  compose: [
    "docker-mailserver:15.1.0@sha256:",
    "PERMIT_DOCKER: none",
    'ENABLE_DNSBL: "1"',
    "POSTSCREEN_ACTION: enforce",
    'ENABLE_RSPAMD: "1"',
    'RSPAMD_GREYLISTING: "1"',
    'ENABLE_FAIL2BAN: "1"',
    "SSL_TYPE: manual",
    "TLS_LEVEL: modern",
    ':25"',
  ],
  postfix: [
    "mynetworks = 127.0.0.0/8 [::1]/128",
    "reject_unverified_recipient",
    "reject_unauth_destination",
    "smtpd_client_connection_count_limit = 10",
    "smtpd_client_connection_rate_limit = 30",
    "smtpd_client_message_rate_limit = 60",
    "smtpd_client_recipient_rate_limit = 200",
    "smtpd_recipient_limit = 100",
    "smtpd_soft_error_limit = 5",
    "smtpd_error_sleep_time = 2s",
    "smtpd_timeout = 60s",
    "smtpd_tls_security_level = may",
  ],
  patch: [
    "HELIX_MAIL_RELAY_DOMAINS",
    "relay_domains = texthash:",
    "transport_maps = texthash:",
    "postconf -M# submission/inet",
    "postconf -M# submissions/inet",
    "postfix check",
  ],
  ratelimit: ['selector = "ip"', 'selector = "digest"', 'rate = "100 / 1min"'],
  readme: [
    "Do not point `MAIL_SMTP_HOST` at this inbound edge",
    "`A`/`AAAA`",
    "`PTR`",
    "`MX`",
    "SPF",
    "DKIM",
    "`_dmarc`",
    "`_mta-sts`",
    "`_smtp._tls`",
    "NOQUEUE: reject",
    "age/depth",
  ],
};

const failures = [];
for (const [key, markers] of Object.entries(required)) {
  for (const marker of markers) {
    if (!files[key].includes(marker)) failures.push(`${paths[key]} missing ${marker}`);
  }
}
for (const forbidden of [":465", ":587", "MAIL_SMTP_USER", "MAIL_SMTP_PASS"]) {
  if (files.compose.includes(forbidden))
    failures.push(`inbound compose exposes outbound ${forbidden}`);
}

const compose = spawnSync(
  "docker",
  ["compose", "--env-file", "infra/mail-edge/.env.example", "-f", paths.compose, "config", "-q"],
  { cwd: new URL("../../", import.meta.url), encoding: "utf8" },
);
if (compose.error?.code !== "ENOENT" && compose.status !== 0) {
  failures.push(`docker compose config failed: ${compose.stderr.trim()}`);
}

if (failures.length > 0) {
  throw new Error(`Mail edge validation failed:\n${failures.join("\n")}`);
}
if (process.argv.includes("--dns")) await validateDns();
process.stdout.write("Mail edge configuration and separation controls validated.\n");

async function validateDns() {
  const domain = requiredEnv("HELIX_MAIL_EDGE_DNS_DOMAIN").toLowerCase();
  const hostname = requiredEnv("HELIX_MAIL_EDGE_DNS_HOST").toLowerCase().replace(/\.$/u, "");
  const expectedIp = requiredEnv("HELIX_MAIL_EDGE_DNS_IP");
  const dkimSelector = requiredEnv("HELIX_MAIL_EDGE_DKIM_SELECTOR");
  const [mx, ipv4, ipv6, ptr, spf, dkim, dmarc, mtaSts, tlsRpt] = await Promise.all([
    resolveMx(domain),
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
    reverse(expectedIp),
    txt(domain),
    txt(`${dkimSelector}._domainkey.${domain}`),
    txt(`_dmarc.${domain}`),
    txt(`_mta-sts.${domain}`),
    txt(`_smtp._tls.${domain}`),
  ]);
  assert(
    mx.some((record) => record.exchange.toLowerCase().replace(/\.$/u, "") === hostname),
    "MX does not target edge hostname",
  );
  assert([...ipv4, ...ipv6].includes(expectedIp), "edge hostname does not resolve to expected IP");
  assert(
    ptr.some((record) => record.toLowerCase().replace(/\.$/u, "") === hostname),
    "PTR does not match edge hostname",
  );
  assert(
    spf.some((record) => record.startsWith("v=spf1")),
    "SPF record missing",
  );
  assert(
    dkim.some((record) => record.startsWith("v=DKIM1") && /\bp=/u.test(record)),
    "DKIM public key record missing",
  );
  assert(
    dmarc.some((record) => record.startsWith("v=DMARC1")),
    "DMARC record missing",
  );
  assert(
    mtaSts.some((record) => record.startsWith("v=STSv1")),
    "MTA-STS TXT record missing",
  );
  assert(
    tlsRpt.some((record) => record.startsWith("v=TLSRPTv1")),
    "TLS-RPT record missing",
  );
  const policy = await globalThis
    .fetch(`https://mta-sts.${domain}/.well-known/mta-sts.txt`)
    .then((response) => {
      assert(response.ok, `MTA-STS policy returned HTTP ${response.status}`);
      return response.text();
    });
  assert(/^version:\s*STSv1$/imu.test(policy), "MTA-STS policy version missing");
  assert(/^mode:\s*(enforce|testing)$/imu.test(policy), "MTA-STS mode must be enforce or testing");
  assert(
    new RegExp(`^mx:\\s*${escapeRegex(hostname)}$`, "imu").test(policy),
    "MTA-STS policy does not name edge hostname",
  );
  await validateStartTls(hostname, positiveIntEnv("HELIX_MAIL_EDGE_DNS_PORT", 25));
}

async function validateStartTls(hostname, port) {
  const socket = net.createConnection({ host: hostname, port });
  socket.setTimeout(10_000);
  try {
    await smtpReply(socket, 220);
    socket.write("EHLO deliverability-probe.invalid\r\n");
    const capabilities = await smtpReply(socket, 250);
    assert(
      /(?:^|\n)250[ -]STARTTLS(?:\s|$)/iu.test(capabilities),
      "SMTP edge does not advertise STARTTLS",
    );
    socket.write("STARTTLS\r\n");
    await smtpReply(socket, 220);
    const secured = tls.connect({ socket, servername: hostname, rejectUnauthorized: true });
    await new Promise((resolve, reject) => {
      secured.once("secureConnect", resolve);
      secured.once("error", reject);
      secured.once("timeout", () => reject(new Error("SMTP TLS handshake timed out")));
    });
    assert(
      secured.authorized,
      `SMTP TLS certificate rejected: ${secured.authorizationError ?? "unknown"}`,
    );
    secured.end();
  } finally {
    if (!socket.destroyed) socket.destroy();
  }
}

function smtpReply(socket, code) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => onError(new Error("SMTP readiness check timed out"));
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n").map((line) => line.trimEnd());
      const final = lines.findLast((line) => /^\d{3} /u.test(line));
      if (final === undefined) return;
      cleanup();
      if (!final.startsWith(`${String(code)} `)) {
        reject(new Error(`SMTP readiness check expected ${String(code)}, received ${final}`));
      } else {
        resolve(lines.join("\n"));
      }
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
  });
}

async function txt(name) {
  return (await resolveTxt(name)).map((parts) => parts.join(""));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required with --dns`);
  return value.trim();
}

function positiveIntEnv(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
