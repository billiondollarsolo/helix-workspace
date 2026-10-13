import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaddyEdgeTarget, EdgeNotRunningError } from "./caddy-target.js";

const bundle = {
  chainPem: "-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----\n",
  // Stands in for a key; the bundle is only concatenated and compared here.
  keyPem: "-----BEGIN TEST KEY-----\nkey\n-----END TEST KEY-----\n",
  fingerprintSha256: "b".repeat(64),
};

interface AdminRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: string;
}

describe("CaddyEdgeTarget", () => {
  let work: string;
  let server: Server;
  let requests: AdminRequest[];
  let answer: { status: number; body: string };

  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), "helix-edge-"));
    requests = [];
    answer = { status: 200, body: "" };
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          cacheControl: request.headers["cache-control"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(answer.status).end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(join(work, "admin.sock"), resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  });

  const target = () =>
    new CaddyEdgeTarget({
      directory: join(work, "certs"),
      edgeDirectory: "/run/helix-edge-certs",
      adminSocketPath: join(work, "admin.sock"),
    });

  it("writes one private bundle the edge can load, and only when it changes", async () => {
    const subject = target();

    await expect(subject.write(bundle)).resolves.toBe(true);

    const path = join(work, "certs", "helix-edge.pem");
    expect(readFileSync(path, "utf8")).toBe(`${bundle.chainPem}${bundle.keyPem}`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No temporary file is left for the edge to trip over.
    expect(readdirSync(join(work, "certs"))).toEqual(["helix-edge.pem"]);
    await expect(subject.write(bundle)).resolves.toBe(false);
    await expect(
      subject.write({ ...bundle, keyPem: bundle.keyPem.replace("key", "renewed") }),
    ).resolves.toBe(true);
  });

  it("removes the bundle to return to automatic HTTPS", async () => {
    const subject = target();
    await expect(subject.write(null)).resolves.toBe(false);
    await subject.write(bundle);

    await expect(subject.write(null)).resolves.toBe(true);

    expect(readdirSync(join(work, "certs"))).toEqual([]);
  });

  it("asks the edge to load its certificate folder again", async () => {
    await target().reload();

    expect(requests).toEqual([
      {
        method: "PATCH",
        url: "/config/apps/tls/certificates/load_folders",
        // The configuration itself is unchanged, so the reload must be forced.
        cacheControl: "must-revalidate",
        body: '["/run/helix-edge-certs"]',
      },
    ]);
  });

  it("reports an edge that refuses or cannot be reached", async () => {
    answer = { status: 500, body: "loading certificates: bad bundle" };
    await expect(target().reload()).rejects.toThrow(
      "The edge refused to reload its certificates (HTTP 500): loading certificates: bad bundle",
    );

    const unreachable = new CaddyEdgeTarget({
      directory: join(work, "certs"),
      edgeDirectory: "/run/helix-edge-certs",
      adminSocketPath: join(work, "missing.sock"),
    });
    await expect(unreachable.reload()).rejects.toBeInstanceOf(EdgeNotRunningError);
  });
});
