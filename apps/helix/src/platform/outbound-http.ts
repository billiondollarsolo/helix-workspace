import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import {
  Agent,
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { env } from "../config/env.js";

export type OutboundHttpErrorCode =
  | "aborted"
  | "blocked_destination"
  | "dns_failed"
  | "invalid_url"
  | "request_too_large"
  | "response_too_large"
  | "transport_failed";

export class OutboundHttpError extends Error {
  constructor(
    readonly code: OutboundHttpErrorCode,
    url: URL,
  ) {
    super(`Outbound HTTP request failed (${code}) for ${redactedOrigin(url)}.`);
    this.name = "OutboundHttpError";
  }
}

export interface ResolvedOutboundAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface OutboundHttpTransportInput {
  readonly url: URL;
  readonly originalUrl: URL;
  readonly address: ResolvedOutboundAddress;
  readonly proxyUrl?: URL;
  readonly proxyServername?: string;
  readonly init: {
    readonly method: string;
    readonly headers: Headers;
    readonly body?: Uint8Array;
    readonly signal: AbortSignal;
    readonly redirect: "manual";
  };
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export interface OutboundHttpClientOptions {
  readonly production?: boolean;
  readonly allowHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  readonly proxyUrl?: string;
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedOutboundAddress[]>;
  readonly transport?: (input: OutboundHttpTransportInput) => Promise<Response>;
}

interface NormalizedOptions {
  readonly allowHttp: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly allowedHosts: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly proxyUrl?: URL;
  readonly resolve: NonNullable<OutboundHttpClientOptions["resolve"]>;
  readonly transport?: NonNullable<OutboundHttpClientOptions["transport"]>;
}

interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: {
    get(name: string): string | null;
    forEach(callback: (value: string, name: string) => void): void;
  };
  readonly body: {
    getReader(): {
      read(): Promise<unknown>;
      cancel(reason?: unknown): Promise<void>;
    };
    cancel(reason?: unknown): Promise<void>;
  } | null;
}

const MiB = 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const crossOriginRedirectHeaders = new Set(["accept", "accept-language", "user-agent"]);
const blockedHostnames = new Set([
  "instance-data.ec2.internal",
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
]);
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** A fetch-compatible client that resolves, validates, and pins every network hop. */
export function createOutboundHttpClient(options: OutboundHttpClientOptions = {}): typeof fetch {
  const policy = normalizeOptions(options);
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = parseUrl(requestUrl(input));
    assertUrlAllowed(url, policy);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const callerSignal = init?.signal ?? request?.signal;
    const signal = combineSignals(callerSignal, AbortSignal.timeout(policy.timeoutMs));
    const rawBody =
      init !== undefined && "body" in init
        ? init.body
        : request === undefined || method === "GET" || method === "HEAD"
          ? undefined
          : request.body;
    const body = await boundedRequestBody(rawBody, policy.maxRequestBytes, url, signal);
    if ((method === "GET" || method === "HEAD") && body !== undefined) {
      throw new OutboundHttpError("invalid_url", url);
    }
    return requestWithRedirects({
      url,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal,
      policy,
    });
  };
}

let defaultClient: typeof fetch | undefined;

/** Shared production default for every tenant- or plugin-configured endpoint. */
export const outboundFetch: typeof fetch = (input, init) => {
  defaultClient ??= createOutboundHttpClient();
  return defaultClient(input, init);
};

export function isPublicOutboundAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 4) return !blockedV4.check(normalized, "ipv4");
  return family === 6 && globalV6.check(normalized, "ipv6") && !blockedV6.check(normalized, "ipv6");
}

async function requestWithRedirects(input: {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
  readonly policy: NormalizedOptions;
}): Promise<Response> {
  let url = input.url;
  let headers = input.headers;
  for (let redirects = 0; ; redirects += 1) {
    assertUrlAllowed(url, input.policy);
    const address = await resolveAndValidate(url, input.policy, false, input.signal);
    const proxy =
      input.policy.proxyUrl === undefined
        ? undefined
        : await resolveProxy(input.policy.proxyUrl, input.policy, input.signal);
    const pinnedUrl = pinUrl(url, address);
    headers.set("host", url.host);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const response = await runTransport(
      {
        url: pinnedUrl,
        originalUrl: url,
        address,
        ...(proxy === undefined
          ? {}
          : {
              proxyUrl: proxy.url,
              proxyServername: proxy.servername,
            }),
        init: {
          method: input.method,
          headers,
          signal: input.signal,
          redirect: "manual",
          ...(input.body === undefined ? {} : { body: input.body }),
        },
        maxResponseBytes: input.policy.maxResponseBytes,
        timeoutMs: input.policy.timeoutMs,
      },
      input.policy,
    );
    const location = response.headers.get("location");
    if (
      !redirectStatuses.has(response.status) ||
      location === null ||
      (input.method !== "GET" && input.method !== "HEAD")
    ) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= input.policy.maxRedirects) {
      throw new OutboundHttpError("blocked_destination", url);
    }
    const next = parseUrl(new URL(location, url).toString());
    if (next.origin !== url.origin) {
      headers = filteredRedirectHeaders(headers);
    }
    url = next;
  }
}

async function runTransport(
  input: OutboundHttpTransportInput,
  policy: NormalizedOptions,
): Promise<Response> {
  try {
    const response = await abortable(
      policy.transport === undefined ? undiciTransport(input) : policy.transport(input),
      input.init.signal,
      input.originalUrl,
    );
    if (policy.transport === undefined) return response;
    return await boundedResponse(
      response,
      input.maxResponseBytes,
      input.originalUrl,
      input.init.signal,
    );
  } catch (error) {
    if (error instanceof OutboundHttpError) throw error;
    if (input.init.signal.aborted) {
      throw new OutboundHttpError("aborted", input.originalUrl);
    }
    throw new OutboundHttpError("transport_failed", input.originalUrl);
  }
}

async function undiciTransport(input: OutboundHttpTransportInput): Promise<Response> {
  const targetHost = normalizedHostname(input.originalUrl);
  let dispatcher: Dispatcher;
  if (input.proxyUrl === undefined) {
    dispatcher = new Agent({
      connect: {
        lookup: pinnedLookup(input.address),
        ...(input.originalUrl.protocol === "https:" ? { servername: targetHost } : {}),
      },
      connectTimeout: input.timeoutMs,
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
      maxResponseSize: input.maxResponseBytes,
      connections: 1,
      pipelining: 1,
    });
  } else {
    dispatcher = new ProxyAgent({
      uri: input.proxyUrl.toString(),
      requestTls: { servername: targetHost },
      proxyTls: { servername: input.proxyServername },
      connectTimeout: input.timeoutMs,
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
      maxResponseSize: input.maxResponseBytes,
      connections: 1,
      pipelining: 1,
    });
  }
  try {
    const requestInit: UndiciRequestInit = {
      method: input.init.method,
      headers: headersRecord(input.init.headers),
      signal: input.init.signal,
      redirect: input.init.redirect,
      ...(input.init.body === undefined ? {} : { body: input.init.body }),
      dispatcher,
    };
    const requestUrl = input.proxyUrl === undefined ? input.originalUrl : input.url;
    const response = await undiciFetch(requestUrl, requestInit);
    return await boundedResponse(
      response,
      input.maxResponseBytes,
      input.originalUrl,
      input.init.signal,
      async () => {
        await (input.init.signal.aborted ? dispatcher.destroy() : dispatcher.close());
      },
    );
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}

async function boundedResponse(
  response: HttpResponse,
  limit: number,
  url: URL,
  signal: AbortSignal,
  onDone: () => Promise<void> = async () => undefined,
): Promise<Response> {
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    await onDone();
  };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    await finish();
    throw new OutboundHttpError("response_too_large", url);
  }
  if (response.body === null || responseHasNoBody(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    await finish();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: copyHeaders(response.headers),
    });
  }
  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result: unknown = await abortable(Promise.resolve(reader.read()), signal, url);
        if (!isStreamResult(result)) throw new OutboundHttpError("transport_failed", url);
        if (result.done) {
          controller.close();
          await finish();
          return;
        }
        size += result.value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => undefined);
          controller.error(new OutboundHttpError("response_too_large", url));
          await finish();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(
          error instanceof OutboundHttpError
            ? error
            : new OutboundHttpError(signal.aborted ? "aborted" : "transport_failed", url),
        );
        await finish();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finish();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: copyHeaders(response.headers),
  });
}

function copyHeaders(headers: HttpResponse["headers"]): Headers {
  const copy = new Headers();
  headers.forEach((value, name) => {
    copy.append(name, value);
  });
  return copy;
}

function headersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

function filteredRedirectHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  headers.forEach((value, name) => {
    if (crossOriginRedirectHeaders.has(name.toLowerCase())) filtered.append(name, value);
  });
  return filtered;
}

async function boundedRequestBody(
  body: unknown,
  limit: number,
  url: URL,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (body === null || body === undefined) return undefined;
  let bytes: Uint8Array;
  if (typeof body === "string" || body instanceof URLSearchParams) {
    bytes = new TextEncoder().encode(body.toString());
  } else if (body instanceof Blob) {
    if (body.size > limit) throw new OutboundHttpError("request_too_large", url);
    bytes = new Uint8Array(await abortable(body.arrayBuffer(), signal, url));
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (isReadableStream(body)) {
    bytes = await readBoundedBody(body, limit, url, signal);
  } else {
    throw new OutboundHttpError("request_too_large", url);
  }
  if (bytes.byteLength > limit) throw new OutboundHttpError("request_too_large", url);
  return bytes;
}

async function readBoundedBody(
  body: ReadableStream<unknown>,
  limit: number,
  url: URL,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result: unknown = await abortable(Promise.resolve(reader.read()), signal, url);
    if (!isStreamResult(result)) throw new OutboundHttpError("request_too_large", url);
    if (result.done) break;
    size += result.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new OutboundHttpError("request_too_large", url);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isStreamResult(
  value: unknown,
): value is { readonly done: true } | { readonly done: false; readonly value: Uint8Array } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.done === true || (record.done === false && record.value instanceof Uint8Array);
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return value instanceof ReadableStream;
}

async function resolveAndValidate(
  url: URL,
  policy: NormalizedOptions,
  allowPrivate: boolean,
  signal: AbortSignal,
): Promise<ResolvedOutboundAddress> {
  const host = normalizedHostname(url);
  const directFamily = isIP(host);
  const directAddress: ResolvedOutboundAddress | undefined =
    directFamily === 4 || directFamily === 6 ? { address: host, family: directFamily } : undefined;
  let addresses: readonly ResolvedOutboundAddress[];
  try {
    addresses =
      directAddress === undefined
        ? await abortable(policy.resolve(host), signal, url)
        : [directAddress];
  } catch (error) {
    if (error instanceof OutboundHttpError) throw error;
    throw new OutboundHttpError("dns_failed", url);
  }
  if (addresses.length === 0) throw new OutboundHttpError("dns_failed", url);
  for (const address of addresses) {
    if (isIP(normalizeAddress(address.address)) !== address.family) {
      throw new OutboundHttpError("dns_failed", url);
    }
    if (!allowPrivate && !policy.allowPrivateNetwork && !isPublicOutboundAddress(address.address)) {
      throw new OutboundHttpError("blocked_destination", url);
    }
  }
  const first = addresses[0];
  if (first === undefined) throw new OutboundHttpError("dns_failed", url);
  return { address: normalizeAddress(first.address), family: first.family };
}

async function resolveProxy(
  url: URL,
  policy: NormalizedOptions,
  signal: AbortSignal,
): Promise<{
  readonly url: URL;
  readonly servername: string;
}> {
  const address = await resolveAndValidate(url, policy, true, signal);
  return { url: pinUrl(url, address), servername: normalizedHostname(url) };
}

function assertUrlAllowed(url: URL, policy: NormalizedOptions): void {
  const host = normalizedHostname(url);
  const trustedPrivateHost = policy.allowPrivateNetwork && policy.allowedHosts.has(host);
  if (
    (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    host.length === 0 ||
    blockedHostnames.has(host) ||
    (!trustedPrivateHost &&
      (host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".home.arpa") ||
        (isIP(host) === 0 && !host.includes(".")))) ||
    (policy.allowedHosts.size > 0 && !policy.allowedHosts.has(host)) ||
    (isIP(host) !== 0 && !policy.allowPrivateNetwork && !isPublicOutboundAddress(host))
  ) {
    throw new OutboundHttpError("blocked_destination", url);
  }
}

function normalizeOptions(options: OutboundHttpClientOptions): NormalizedOptions {
  const config = env();
  const production = options.production ?? config.NODE_ENV === "production";
  const allowHttp = options.allowHttp ?? !production;
  const allowPrivateNetwork = options.allowPrivateNetwork ?? !production;
  const allowedHosts = new Set((options.allowedHosts ?? []).map(normalizeHostname));
  if (production && (allowHttp || allowPrivateNetwork) && allowedHosts.size === 0) {
    throw new TypeError("Production outbound policy exceptions require an exact host allowlist.");
  }
  return {
    allowHttp,
    allowPrivateNetwork,
    allowedHosts,
    timeoutMs: positiveInteger(options.timeoutMs, 15_000, "timeoutMs"),
    maxRequestBytes: positiveInteger(options.maxRequestBytes, 128 * MiB, "maxRequestBytes"),
    maxResponseBytes: positiveInteger(options.maxResponseBytes, 128 * MiB, "maxResponseBytes"),
    maxRedirects: nonNegativeInteger(options.maxRedirects, 3, "maxRedirects"),
    ...(options.proxyUrl === undefined && config.HELIX_OUTBOUND_HTTP_PROXY_URL === undefined
      ? {}
      : {
          proxyUrl: parseProxyUrl(options.proxyUrl ?? config.HELIX_OUTBOUND_HTTP_PROXY_URL ?? ""),
        }),
    resolve:
      options.resolve ??
      (async (hostname) =>
        (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
          address,
          family: family === 6 ? 6 : 4,
        }))),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  };
}

function parseUrl(value: string): URL {
  try {
    const url = new URL(value);
    url.hash = "";
    return url;
  } catch {
    throw new OutboundHttpError("invalid_url", new URL("https://invalid.invalid"));
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function parseProxyUrl(value: string): URL {
  const url = parseUrl(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Outbound proxy URL must use http or https.");
  }
  return url;
}

function pinUrl(url: URL, address: ResolvedOutboundAddress): URL {
  const pinned = new URL(url);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  return pinned;
}

function pinnedLookup(address: ResolvedOutboundAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function normalizedHostname(url: URL): string {
  return normalizeHostname(url.hostname.replace(/^\[|\]$/gu, ""));
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/u, "");
}

function normalizeAddress(address: string): string {
  return (
    address
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .split("%", 1)[0] ?? ""
  );
}

function responseHasNoBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

function redactedOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function combineSignals(left: AbortSignal | null | undefined, right: AbortSignal): AbortSignal {
  return left === null || left === undefined ? right : AbortSignal.any([left, right]);
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  url: URL,
): Promise<T> {
  if (signal === null || signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new OutboundHttpError("aborted", url));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new OutboundHttpError("aborted", url));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new OutboundHttpError("transport_failed", url));
      },
    );
  });
}
