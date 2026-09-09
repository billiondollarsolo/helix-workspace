#!/usr/bin/env node
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

async function main() {
  const host = requiredEnv("HELIX_MAIL_EDGE_SMOKE_HOST");
  const domain = requiredEnv("HELIX_MAIL_EDGE_SMOKE_DOMAIN");
  const recipient = requiredEnv("HELIX_MAIL_EDGE_SMOKE_RECIPIENT");
  const port = positiveInt("HELIX_MAIL_EDGE_SMOKE_PORT", 25);
  const maxBytes = positiveInt("HELIX_MAIL_EDGE_SMOKE_MAX_BYTES", 52_428_800);
  const connections = positiveInt("HELIX_MAIL_EDGE_SMOKE_LOAD_CONNECTIONS", 11);
  const marker = `helix-mail-edge-${randomUUID()}`;

  let session = await SmtpSession.connect(host, port);
  expectCode(await session.reply(), 220, "greeting");
  let ehlo = await session.command(`EHLO smoke.${domain}`);
  expectCode(ehlo, 250, "EHLO");
  assert(
    ehlo.lines.some((line) => /\bSTARTTLS\b/iu.test(line)),
    "STARTTLS not advertised",
  );
  assert(
    ehlo.lines.some((line) => new RegExp(`\\bSIZE\\s+${maxBytes}\\b`, "u").test(line)),
    "bounded SIZE not advertised",
  );
  assert(
    !ehlo.lines.some((line) => /\bAUTH\b/iu.test(line)),
    "AUTH must not be advertised on inbound port 25",
  );

  session = await session.startTls(host);
  ehlo = await session.command(`EHLO smoke.${domain}`);
  expectCode(ehlo, 250, "post-TLS EHLO");
  expectCode(await session.command("MAIL FROM:<probe@example.net>"), 250, "relay MAIL FROM");
  expectClass(await session.command("RCPT TO:<postmaster@gmail.com>"), 5, "unauthorized relay");
  expectCode(await session.command("RSET"), 250, "RSET");
  expectCode(
    await session.command(`MAIL FROM:<probe@example.net> SIZE=${maxBytes + 1}`),
    552,
    "oversize MAIL FROM",
  );
  expectCode(await session.command("RSET"), 250, "RSET");

  const message = [
    `From: Helix edge probe <probe@example.net>`,
    `To: ${recipient}`,
    `Subject: ${marker}`,
    `Message-ID: <${marker}@${domain}>`,
    "",
    marker,
  ].join("\r\n");
  await deliver(session, recipient, message);
  await deliver(session, recipient, message);
  await session.command("QUIT").catch(() => undefined);

  const greetings = await Promise.all(
    Array.from({ length: connections }, async () => {
      const connection = await SmtpSession.connect(host, port).catch(() => null);
      if (connection === null) return 421;
      try {
        return (await connection.reply()).code;
      } catch {
        return 421;
      } finally {
        connection.close();
      }
    }),
  );
  assert(
    greetings.some((code) => code >= 400),
    `connection pressure accepted all ${connections} clients`,
  );
  process.stdout.write(
    `${JSON.stringify({ host, port, marker, relayDenied: true, oversizedDenied: true, exactRetries: 2, greetings })}\n`,
  );
}

async function deliver(connection, address, raw) {
  expectCode(await connection.command("MAIL FROM:<probe@example.net>"), 250, "delivery MAIL FROM");
  expectClass(await connection.command(`RCPT TO:<${address}>`), 2, "known recipient");
  expectCode(await connection.command("DATA"), 354, "DATA");
  const reply = await connection.command(`${raw.replace(/^\./gmu, "..")}\r\n.`);
  expectClass(reply, 2, "message acceptance");
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    this.waiters = [];
    this.onData = (chunk) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const end = this.buffer.indexOf("\r\n");
        if (end < 0) break;
        this.pushLine(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 2);
      }
    };
    socket.on("data", this.onData);
  }

  static async connect(hostname, smtpPort) {
    const socket = net.createConnection({ host: hostname, port: smtpPort });
    socket.setTimeout(15_000, () => socket.destroy(new Error("SMTP timeout")));
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new SmtpSession(socket);
  }

  async startTls(servername) {
    expectCode(await this.command("STARTTLS"), 220, "STARTTLS");
    this.socket.off("data", this.onData);
    const socket = tls.connect({ socket: this.socket, servername, minVersion: "TLSv1.2" });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    return new SmtpSession(socket);
  }

  command(command) {
    this.socket.write(`${command}\r\n`);
    return this.reply();
  }

  async reply() {
    const lines = [];
    let code;
    for (;;) {
      const line = await this.line();
      lines.push(line);
      const match = /^(\d{3})([ -])/u.exec(line);
      if (match === null) continue;
      code ??= Number(match[1]);
      if (match[2] === " ") return { code, lines };
    }
  }

  line() {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP reply timeout")), 15_000);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  pushLine(line) {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.lines.push(line);
    else waiter(line);
  }

  close() {
    this.socket.destroy();
  }
}

function expectCode(reply, code, step) {
  assert(reply.code === code, `${step}: expected ${code}, got ${reply.lines.join(" | ")}`);
}

function expectClass(reply, codeClass, step) {
  assert(
    Math.floor(reply.code / 100) === codeClass,
    `${step}: unexpected ${reply.lines.join(" | ")}`,
  );
}

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main();
