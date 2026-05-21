import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions } from "node:tls";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { hostname } from "node:os";
import type { ImmutableAuditActivityRecord, ImmutableAuditShipResult } from "./immutable-s3.js";
import type { AuditBatchShipper } from "./shipping-worker.js";
import { formatAuditRecord, type SiemAuditFormat } from "./siem-format.js";

/**
 * SIEM audit destination — ships hash-chained audit records to a SIEM as
 * RFC 5424 syslog messages whose payload is a CEF or LEEF formatted event.
 *
 * Three transports are supported, matching PRD §15.5 / Tier 3:
 *  - `tcp`  — RFC 6587 octet-counting framing over plain TCP.
 *  - `tls`  — the same framing over a TLS socket (recommended for Tier 3).
 *  - `udp`  — one RFC 5424 message per datagram (RFC 5426).
 *
 * The shipper implements {@link AuditBatchShipper} so it is a drop-in
 * alternative to `shipImmutableAuditBatch` for the `AuditShippingWorker`.
 *
 * server.ts wiring (do NOT edit server.ts here — register later):
 *
 * ```ts
 * import { SiemAuditShipper } from "./platform/audit/siem-syslog.js";
 * import { AuditShippingWorker } from "./platform/audit/shipping-worker.js";
 *
 * // siemConfig is read from platform config alongside auditShippingConfig.
 * const siemAuditWorker =
 *   siemConfig === undefined
 *     ? undefined
 *     : new AuditShippingWorker({
 *         store: auditStore,
 *         destination: "siem-syslog",
 *         batchSize: siemConfig.batchSize,
 *         intervalMs: siemConfig.intervalMs,
 *         shipper: new SiemAuditShipper({
 *           host: siemConfig.host,
 *           port: siemConfig.port,
 *           transport: siemConfig.transport,   // "tcp" | "tls" | "udp"
 *           format: siemConfig.format,         // "cef" | "leef"
 *           tls: siemConfig.tls,               // { ca, cert, key, rejectUnauthorized }
 *         }),
 *         onResult: (result) => {
 *           if (result.status === "shipped") {
 *             metrics.recordAuditShipping({
 *               destination: result.destination,
 *               recordCount: result.shippedRecordCount,
 *               lagSeconds: result.lagSeconds,
 *             });
 *           }
 *         },
 *       });
 * // ...later, gated by LeaderElection like the other singleton workers:
 * siemAuditWorker?.start();
 * // ...and in the graceful-shutdown drain:
 * await siemAuditWorker?.stop();
 * ```
 */

export type SiemSyslogTransport = "tcp" | "tls" | "udp";

/**
 * Pluggable transport: the production transports below speak real sockets;
 * tests can supply an in-memory transport implementing this interface.
 */
export interface SiemSyslogTransportClient {
  /** Send one already-framed payload (octet-counted for TCP/TLS, raw for UDP). */
  send(payload: Buffer): Promise<void>;
  /** Close the underlying socket, if any. */
  close(): Promise<void>;
}

export interface SiemSyslogTlsOptions {
  readonly ca?: string | readonly string[];
  readonly cert?: string;
  readonly key?: string;
  readonly servername?: string;
  /** Defaults to true — verify the SIEM server certificate. */
  readonly rejectUnauthorized?: boolean;
}

export interface SiemAuditShipperOptions {
  readonly host: string;
  readonly port: number;
  readonly transport: SiemSyslogTransport;
  readonly format: SiemAuditFormat;
  /** Syslog facility (0-23). Defaults to 13 (log audit). */
  readonly facility?: number;
  /** Syslog severity (0-7). Defaults to 6 (informational). */
  readonly severity?: number;
  /** APP-NAME field in the RFC 5424 header. Defaults to "helix-audit". */
  readonly appName?: string;
  /** HOSTNAME field. Defaults to os.hostname(). */
  readonly host_name?: string;
  /** Connection timeout in ms for TCP/TLS. Defaults to 10_000. */
  readonly connectTimeoutMs?: number;
  readonly tls?: SiemSyslogTlsOptions;
  readonly now?: () => Date;
  /** Test seam: inject a transport instead of opening a real socket. */
  readonly transportFactory?: (options: SiemAuditShipperOptions) => SiemSyslogTransportClient;
}

const defaultFacility = 13;
const defaultSeverity = 6;
const defaultAppName = "helix-audit";
const defaultConnectTimeoutMs = 10_000;
const syslogVersion = 1;
const bom = "﻿";

/**
 * Build the RFC 5424 SYSLOG-MSG for a single audit record. The MSG part is the
 * CEF/LEEF event; STRUCTURED-DATA carries the Helix hash so a syslog relay that
 * strips the MSG still keeps the chain reference.
 */
export function buildSyslogMessage(
  record: ImmutableAuditActivityRecord,
  options: {
    readonly format: SiemAuditFormat;
    readonly facility: number;
    readonly severity: number;
    readonly appName: string;
    readonly hostname: string;
    readonly timestamp: Date;
  },
): string {
  const priority = options.facility * 8 + options.severity;
  const timestamp = options.timestamp.toISOString();
  const procId = "-";
  const msgId = record.verb;
  const structuredData =
    `[helix@32473 recordId="${escapeSdValue(record.id)}" ` +
    `orgId="${escapeSdValue(record.orgId)}" ` +
    `thisHash="${escapeSdValue(record.thisHash)}"]`;
  const msg = formatAuditRecord(options.format, record);

  return (
    `<${String(priority)}>${String(syslogVersion)} ${timestamp} ` +
    `${sanitizeHeaderField(options.hostname)} ${sanitizeHeaderField(options.appName)} ` +
    `${procId} ${sanitizeHeaderField(msgId)} ${structuredData} ${bom}${msg}`
  );
}

/** RFC 6587 octet-counting framing: `MSG-LEN SP SYSLOG-MSG`. */
export function frameOctetCounting(message: string): Buffer {
  const body = Buffer.from(message, "utf8");
  return Buffer.concat([Buffer.from(`${String(body.length)} `, "utf8"), body]);
}

export class SiemAuditShipper implements AuditBatchShipper {
  readonly #options: SiemAuditShipperOptions;
  readonly #facility: number;
  readonly #severity: number;
  readonly #appName: string;
  readonly #hostname: string;
  readonly #now: () => Date;

  constructor(options: SiemAuditShipperOptions) {
    if (options.host.length === 0) {
      throw new TypeError("SIEM audit shipper requires a host");
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new TypeError("SIEM audit shipper port must be a valid TCP/UDP port");
    }
    this.#facility = integerInRange(options.facility ?? defaultFacility, 0, 23, "facility");
    this.#severity = integerInRange(options.severity ?? defaultSeverity, 0, 7, "severity");
    this.#appName = options.appName ?? defaultAppName;
    this.#hostname = options.host_name ?? hostname();
    this.#now = options.now ?? (() => new Date());
    this.#options = options;
  }

  async ship(records: readonly ImmutableAuditActivityRecord[]): Promise<ImmutableAuditShipResult> {
    if (records.length === 0) {
      throw new TypeError("SIEM audit shipper requires at least one record");
    }

    const transport = this.#createTransport();
    let shippedCount = 0;
    try {
      for (const record of records) {
        const message = buildSyslogMessage(record, {
          format: this.#options.format,
          facility: this.#facility,
          severity: this.#severity,
          appName: this.#appName,
          hostname: this.#hostname,
          timestamp: this.#now(),
        });
        const payload =
          this.#options.transport === "udp"
            ? Buffer.from(message, "utf8")
            : frameOctetCounting(message);
        await transport.send(payload);
        shippedCount += 1;
      }
    } finally {
      await transport.close();
    }

    const first = records[0];
    const last = records[records.length - 1];
    if (first === undefined || last === undefined) {
      throw new TypeError("SIEM audit shipper requires at least one record");
    }

    return {
      batchId: `${this.#options.transport}:${this.#options.format}:${last.id}`,
      recordCount: shippedCount,
      recordsKey: `siem://${this.#options.host}:${String(this.#options.port)}`,
      recordsSha256: last.thisHash,
      manifestKey: `siem://${this.#options.host}:${String(this.#options.port)}/manifest`,
      manifestSha256: first.thisHash,
    };
  }

  #createTransport(): SiemSyslogTransportClient {
    if (this.#options.transportFactory !== undefined) {
      return this.#options.transportFactory(this.#options);
    }
    switch (this.#options.transport) {
      case "udp":
        return new UdpSyslogTransport(this.#options.host, this.#options.port);
      case "tcp":
        return new StreamSyslogTransport(this.#options, false);
      case "tls":
        return new StreamSyslogTransport(this.#options, true);
      default: {
        const exhaustive: never = this.#options.transport;
        throw new TypeError(`Unsupported SIEM transport: ${String(exhaustive)}`);
      }
    }
  }
}

/** TCP / TLS transport — lazily connects, writes octet-counted frames. */
class StreamSyslogTransport implements SiemSyslogTransportClient {
  #socket: Socket | undefined;
  #connecting: Promise<Socket> | undefined;

  constructor(
    private readonly options: SiemAuditShipperOptions,
    private readonly useTls: boolean,
  ) {}

  async send(payload: Buffer): Promise<void> {
    const socket = await this.#ensureConnected();
    await new Promise<void>((resolve, reject) => {
      socket.write(payload, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    this.#socket = undefined;
    await new Promise<void>((resolve) => {
      socket.end(() => {
        socket.destroy();
        resolve();
      });
    });
  }

  #ensureConnected(): Promise<Socket> {
    if (this.#socket !== undefined) {
      return Promise.resolve(this.#socket);
    }
    if (this.#connecting !== undefined) {
      return this.#connecting;
    }

    const timeoutMs = this.options.connectTimeoutMs ?? defaultConnectTimeoutMs;
    this.#connecting = new Promise<Socket>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#connecting = undefined;
        reject(error);
      };
      let socket: Socket;
      if (this.useTls) {
        const tlsOptions: TlsConnectionOptions = {
          host: this.options.host,
          port: this.options.port,
          rejectUnauthorized: this.options.tls?.rejectUnauthorized ?? true,
          ...(this.options.tls?.ca === undefined ? {} : { ca: this.options.tls.ca as string[] }),
          ...(this.options.tls?.cert === undefined ? {} : { cert: this.options.tls.cert }),
          ...(this.options.tls?.key === undefined ? {} : { key: this.options.tls.key }),
          ...(this.options.tls?.servername === undefined
            ? {}
            : { servername: this.options.tls.servername }),
        };
        socket = tlsConnect(tlsOptions, () => {
          socket.setTimeout(0);
          socket.removeListener("error", onError);
          this.#socket = socket;
          this.#connecting = undefined;
          resolve(socket);
        });
      } else {
        socket = netConnect({ host: this.options.host, port: this.options.port }, () => {
          socket.setTimeout(0);
          socket.removeListener("error", onError);
          this.#socket = socket;
          this.#connecting = undefined;
          resolve(socket);
        });
      }
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error("SIEM syslog connection timed out"));
      });
      socket.once("error", onError);
    });
    return this.#connecting;
  }
}

/** UDP transport — one datagram per message (RFC 5426). */
class UdpSyslogTransport implements SiemSyslogTransportClient {
  #socket: DgramSocket | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  async send(payload: Buffer): Promise<void> {
    const socket = this.#ensureSocket();
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, this.port, this.host, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    this.#socket = undefined;
    await new Promise<void>((resolve) => {
      socket.close(() => {
        resolve();
      });
    });
  }

  #ensureSocket(): DgramSocket {
    if (this.#socket === undefined) {
      this.#socket = createSocket("udp4");
    }
    return this.#socket;
  }
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`SIEM audit shipper ${label} must be an integer in [${String(min)}, ${String(max)}]`);
  }
  return value;
}

/** Strip SP and control chars from RFC 5424 header fields (NILVALUE if empty). */
function sanitizeHeaderField(value: string): string {
  const cleaned = Array.from(value).filter((c) => { const code = c.codePointAt(0) ?? 0; return code > 0x20 && code !== 0x7f; }).join("");
  return cleaned.length === 0 ? "-" : cleaned;
}

/** Escape STRUCTURED-DATA PARAM-VALUE per RFC 5424 §6.3.3. */
function escapeSdValue(value: string): string {
  return value.replace(/[\\\]"]/g, (character) => `\\${character}`);
}
