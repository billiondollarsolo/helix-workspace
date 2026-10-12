import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { EdgeCertificateBundle } from "./store.js";

/**
 * Hands the operator's certificate to the Caddy edge.
 *
 * Caddy loads every `.pem` bundle in one folder when its configuration is
 * (re)loaded, and stops obtaining a certificate for names such a bundle
 * covers. Helix owns that folder: writing the bundle selects the operator's
 * certificate, removing it returns the edge to automatic HTTPS, and either
 * takes effect on a reload requested over Caddy's admin socket. Because the
 * bundle is a file, a restarted edge serves the right certificate before
 * Helix is reachable.
 */

const BUNDLE_FILE = "helix-edge.pem";

export interface CaddyEdgeTargetOptions {
  /** The certificate folder as Helix sees it. */
  readonly directory: string;
  /** The same folder as the edge sees it. */
  readonly edgeDirectory: string;
  /** Caddy's admin Unix socket. */
  readonly adminSocketPath: string;
  readonly timeoutMs?: number;
}

/** The edge is not running. It loads the certificate folder when it starts. */
export class EdgeNotRunningError extends Error {
  constructor() {
    super("The edge is not running.");
    this.name = "EdgeNotRunningError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bundlePem(bundle: EdgeCertificateBundle): string {
  return `${bundle.chainPem.trimEnd()}\n${bundle.keyPem.trimEnd()}\n`;
}

export class CaddyEdgeTarget {
  private readonly path: string;

  constructor(private readonly options: CaddyEdgeTargetOptions) {
    this.path = join(options.directory, BUNDLE_FILE);
  }

  /** Makes the folder hold exactly `bundle`. Returns whether anything changed. */
  async write(bundle: EdgeCertificateBundle | null): Promise<boolean> {
    const current = await readFile(this.path, "utf8").catch(() => null);
    if (bundle === null) {
      if (current === null) return false;
      await rm(this.path, { force: true });
      return true;
    }
    const next = bundlePem(bundle);
    if (current !== null && sha256(current) === sha256(next)) return false;
    await mkdir(this.options.directory, { recursive: true });
    // Rename so the edge never reads a half-written bundle. The temporary
    // name is not `.pem`, which the edge ignores.
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, this.path);
    return true;
  }

  /** Asks the edge to load its certificate folder again. */
  async reload(): Promise<void> {
    const body = JSON.stringify([this.options.edgeDirectory]);
    await new Promise<void>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: this.options.adminSocketPath,
          method: "PATCH",
          path: "/config/apps/tls/certificates/load_folders",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            // The configuration is unchanged; only the folder's contents are.
            "cache-control": "must-revalidate",
          },
          timeout: this.options.timeoutMs ?? 10_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            if (response.statusCode === 200) {
              resolve();
              return;
            }
            const detail = Buffer.concat(chunks).toString("utf8").slice(0, 300);
            reject(
              new Error(
                `The edge refused to reload its certificates (HTTP ${String(response.statusCode)}): ${detail}`,
              ),
            );
          });
        },
      );
      outgoing.on("timeout", () => {
        outgoing.destroy(new Error("The edge did not answer the reload request in time."));
      });
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? new EdgeNotRunningError()
            : error,
        );
      });
      outgoing.end(body);
    });
  }
}
