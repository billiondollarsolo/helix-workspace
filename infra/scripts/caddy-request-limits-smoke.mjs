import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const caddyfilePath = path.join(root, "infra/caddy/Caddyfile");
const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
const caddyImage = compose.match(/\n {2}caddy:\n {4}image: ([^\s]+)/u)?.[1];
assert.ok(caddyImage?.includes("@sha256:"), "Compose must pin the Caddy image by digest");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "helix-caddy-limits-"));
const testCaddyfile = path.join(tempDir, "Caddyfile");
const containerName = `helix-caddy-limits-${String(process.pid)}`;
let proxy;

const receivedBytes = new Map();
const upstream = http.createServer((request, response) => {
  const testCase = request.headers["x-test-case"] ?? "unlabelled";
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
  });
  const record = () => {
    receivedBytes.set(testCase, Math.max(receivedBytes.get(testCase) ?? 0, bytes));
  };
  request.on("aborted", record);
  request.on("end", () => {
    record();
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
});

try {
  const source = await readFile(caddyfilePath, "utf8");
  const reduced = source
    .replace("max_header_size 32KB", "max_header_size 1KB")
    .replace("read_header 10s", "read_header 300ms")
    .replace("read_body 2m", "read_body 300ms")
    .replace("max_size 2MB", "max_size 1KB")
    .replace("max_size 32MB", "max_size 2KB")
    .replace("max_size 64MB", "max_size 4KB");
  assert.notEqual(reduced, source, "Caddy limit fixtures were not reduced");
  await writeFile(testCaddyfile, reduced);

  const upstreamPort = await listen(upstream);
  const proxyPort = await availablePort();
  proxy = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      ...(process.platform === "linux" ? ["--add-host=host.docker.internal:host-gateway"] : []),
      "-p",
      `127.0.0.1:${String(proxyPort)}:8080`,
      "-e",
      "HELIX_DOMAIN=http://:8080",
      "-e",
      `HELIX_UPSTREAM=host.docker.internal:${String(upstreamPort)}`,
      "-v",
      `${testCaddyfile}:/etc/caddy/Caddyfile:ro`,
      caddyImage,
      "caddy",
      "run",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let proxyLogs = "";
  proxy.stdout.on("data", (chunk) => {
    proxyLogs += chunk.toString();
  });
  proxy.stderr.on("data", (chunk) => {
    proxyLogs += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${String(proxyPort)}`;
  await waitForProxy(`${baseUrl}/healthz`, proxy, () => proxyLogs);

  await expectStatus(`${baseUrl}/v1/api/tools/chat.send`, "POST", 900, 200, "standard-ok");
  await expectStatus(`${baseUrl}/v1/api/tools/chat.send`, "POST", 1_100, 413, "standard-over");
  await expectStatus(`${baseUrl}/v1/api/tools/drive.finalize`, "POST", 1_900, 200, "bulk-ok");
  await expectStatus(`${baseUrl}/v1/api/tools/drive.finalize`, "POST", 2_100, 413, "bulk-over");
  await expectStatus(`${baseUrl}/v1/dav/files/example.bin`, "PUT", 3_900, 200, "upload-ok");
  await expectStatus(`${baseUrl}/v1/dav/files/example.bin`, "PUT", 4_100, 413, "upload-over");

  const headerResponse = await globalThis.fetch(`${baseUrl}/healthz`, {
    headers: { "x-oversized-header": "x".repeat(64_000) },
  });
  assert.equal(headerResponse.status, 431, "oversized headers must return 431");

  await expectPromptClose(
    proxyPort,
    "POST /v1/api/tools/chat.send HTTP/1.1\r\nHost: localhost\r\n",
    "incomplete headers",
  );
  await expectPromptClose(
    proxyPort,
    "POST /v1/api/tools/chat.send HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx",
    "incomplete body",
  );

  const flood = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      globalThis.fetch(`${baseUrl}/v1/api/tools/chat.send`, {
        method: "POST",
        headers: { "x-test-case": `flood-${String(index)}` },
        body: Buffer.alloc(1_100),
      }),
    ),
  );
  assert.ok(
    flood.every((response) => response.status === 413),
    "oversized flood must be rejected",
  );
  assert.equal(
    (await globalThis.fetch(`${baseUrl}/healthz`)).status,
    200,
    "proxy must recover after flood",
  );
  for (const [testCase, limit] of [
    ["standard-over", 1_000],
    ["bulk-over", 2_000],
    ["upload-over", 4_000],
  ]) {
    assert.ok((receivedBytes.get(testCase) ?? 0) <= limit, `${testCase} crossed its upstream cap`);
  }
  assert.ok(
    [...receivedBytes.entries()]
      .filter(([name]) => name.startsWith("flood-"))
      .every(([, bytes]) => bytes <= 1_000),
    "oversized flood bytes crossed the standard upstream cap",
  );

  process.stdout.write("Caddy request limit live smoke passed.\n");
} finally {
  spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  proxy?.kill();
  await close(upstream);
  await rm(tempDir, { recursive: true, force: true });
}

async function expectStatus(url, method, bytes, status, testCase) {
  const response = await globalThis.fetch(url, {
    method,
    headers: { "x-test-case": testCase },
    body: Buffer.alloc(bytes),
  });
  assert.equal(response.status, status, `${testCase} returned ${String(response.status)}`);
  await response.arrayBuffer();
}

async function expectPromptClose(port, payload, label) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => socket.write(payload));
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error(`${label} connection exceeded its read timeout`));
    }, 2_000);
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    };
    socket.once("data", done);
    socket.once("error", done);
    socket.once("close", done);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForProxy(url, child, logs) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Caddy exited during startup:\n${logs()}`);
    }
    try {
      if ((await globalThis.fetch(url)).ok) return;
    } catch {
      // Container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Caddy did not become ready:\n${logs()}`);
}
