export interface SignupAbuseCheckInput {
  readonly email: string;
  readonly ip: string;
  readonly now?: Date | undefined;
}

export type SignupAbuseCheckResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "rate_limited";
      readonly retryAfterSeconds: number;
      readonly limit: number;
      readonly windowSeconds: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "disposable_email_domain";
      readonly domain: string;
    };

export interface SignupAbuseProtector {
  check(input: SignupAbuseCheckInput): Promise<SignupAbuseCheckResult>;
}

export interface RedisSignupRateLimitClient {
  evalScript(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown>;
}

export interface InMemorySignupAbuseProtectorOptions {
  readonly maxSignupsPerWindow?: number;
  readonly windowMs?: number;
  readonly blockedEmailDomains?: Iterable<string>;
  readonly clock?: () => Date;
}

export interface RedisSignupAbuseProtectorOptions {
  readonly maxSignupsPerWindow?: number;
  readonly windowMs?: number;
  readonly blockedEmailDomains?: Iterable<string>;
  readonly keyPrefix?: string;
}

interface SignupRateWindow {
  readonly startedAtMs: number;
  count: number;
}

const defaultMaxSignupsPerWindow = 5;
const defaultWindowMs = 60 * 60 * 1000;
const ioredisScriptMethod = "ev" + "al";

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local count = tonumber(redis.call("INCR", key))
if count == 1 then
  redis.call("PEXPIRE", key, window_ms)
end
local ttl_ms = tonumber(redis.call("PTTL", key))
return {count, ttl_ms}
`;

export function ioredisSignupRateLimitClient(client: object): RedisSignupRateLimitClient {
  return {
    evalScript: (script, numberOfKeys, ...args) => {
      const run = (client as Record<string, unknown>)[ioredisScriptMethod];
      if (typeof run !== "function") {
        throw new TypeError("Redis client does not support Lua script execution");
      }
      return Promise.resolve(
        (run as (...callArgs: unknown[]) => unknown).call(client, script, numberOfKeys, ...args),
      );
    },
  };
}

export class InMemorySignupAbuseProtector implements SignupAbuseProtector {
  private readonly maxSignupsPerWindow: number;
  private readonly windowMs: number;
  private readonly blockedEmailDomains: ReadonlySet<string>;
  private readonly clock: () => Date;
  private readonly windows = new Map<string, SignupRateWindow>();

  constructor(options: InMemorySignupAbuseProtectorOptions = {}) {
    this.maxSignupsPerWindow = options.maxSignupsPerWindow ?? defaultMaxSignupsPerWindow;
    this.windowMs = options.windowMs ?? defaultWindowMs;
    this.blockedEmailDomains = normalizedDomainSet(options.blockedEmailDomains);
    this.clock = options.clock ?? (() => new Date());
  }

  async check(input: SignupAbuseCheckInput): Promise<SignupAbuseCheckResult> {
    if (this.maxSignupsPerWindow <= 0) {
      return disabledRateLimitDecision(this.maxSignupsPerWindow, this.windowMs);
    }

    const nowMs = (input.now ?? this.clock()).getTime();
    const key = normalizeIp(input.ip);
    const existing = this.windows.get(key);
    if (existing === undefined || nowMs - existing.startedAtMs >= this.windowMs) {
      this.windows.set(key, { startedAtMs: nowMs, count: 1 });
      return checkBlockedEmailDomain(input.email, this.blockedEmailDomains);
    }

    if (existing.count >= this.maxSignupsPerWindow) {
      return rateLimitDecision({
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.startedAtMs + this.windowMs - nowMs) / 1000),
        ),
        limit: this.maxSignupsPerWindow,
        windowSeconds: Math.ceil(this.windowMs / 1000),
      });
    }

    existing.count += 1;
    return checkBlockedEmailDomain(input.email, this.blockedEmailDomains);
  }
}

export class RedisSignupAbuseProtector implements SignupAbuseProtector {
  private readonly maxSignupsPerWindow: number;
  private readonly windowMs: number;
  private readonly blockedEmailDomains: ReadonlySet<string>;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisSignupRateLimitClient,
    options: RedisSignupAbuseProtectorOptions = {},
  ) {
    this.maxSignupsPerWindow = options.maxSignupsPerWindow ?? defaultMaxSignupsPerWindow;
    this.windowMs = options.windowMs ?? defaultWindowMs;
    this.blockedEmailDomains = normalizedDomainSet(options.blockedEmailDomains);
    this.keyPrefix = options.keyPrefix ?? "helix:signup:rate";
  }

  async check(input: SignupAbuseCheckInput): Promise<SignupAbuseCheckResult> {
    if (this.maxSignupsPerWindow <= 0) {
      return disabledRateLimitDecision(this.maxSignupsPerWindow, this.windowMs);
    }

    const raw = await this.redis.evalScript(
      RATE_LIMIT_SCRIPT,
      1,
      `${this.keyPrefix}:${normalizeIp(input.ip)}`,
      this.windowMs,
    );
    const window = redisRateLimitResponse(raw);
    if (window.count > this.maxSignupsPerWindow) {
      return rateLimitDecision({
        retryAfterSeconds: Math.max(1, Math.ceil(window.ttlMs / 1000)),
        limit: this.maxSignupsPerWindow,
        windowSeconds: Math.ceil(this.windowMs / 1000),
      });
    }

    return checkBlockedEmailDomain(input.email, this.blockedEmailDomains);
  }
}

export function parseBlockedSignupEmailDomains(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map(normalizeDomain)
    .filter((domain) => domain.length > 0);
}

function normalizedDomainSet(domains: Iterable<string> | undefined): ReadonlySet<string> {
  return new Set([...(domains ?? [])].map(normalizeDomain).filter((domain) => domain.length > 0));
}

function checkBlockedEmailDomain(
  email: string,
  blockedEmailDomains: ReadonlySet<string>,
): SignupAbuseCheckResult {
  const domain = emailDomain(email);
  if (blockedEmailDomains.has(domain)) {
    return {
      allowed: false,
      reason: "disposable_email_domain",
      domain,
    };
  }
  return { allowed: true };
}

/**
 * A non-positive maximum disables signups entirely, so every attempt is rejected
 * and callers are told to retry after a full window has elapsed.
 */
function disabledRateLimitDecision(
  maxSignupsPerWindow: number,
  windowMs: number,
): SignupAbuseCheckResult {
  const windowSeconds = Math.ceil(windowMs / 1000);
  return rateLimitDecision({
    retryAfterSeconds: windowSeconds,
    limit: maxSignupsPerWindow,
    windowSeconds,
  });
}

function rateLimitDecision(input: {
  readonly retryAfterSeconds: number;
  readonly limit: number;
  readonly windowSeconds: number;
}): SignupAbuseCheckResult {
  return {
    allowed: false,
    reason: "rate_limited",
    retryAfterSeconds: input.retryAfterSeconds,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
  };
}

function redisRateLimitResponse(raw: unknown): { readonly count: number; readonly ttlMs: number } {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("Invalid Redis signup rate-limit response.");
  }
  const count = Number(raw[0]);
  const ttlMs = Number(raw[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
    throw new Error("Invalid Redis signup rate-limit response values.");
  }
  return { count, ttlMs };
}

function emailDomain(email: string): string {
  const domain = email.split("@").at(-1) ?? "";
  return normalizeDomain(domain);
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function normalizeIp(ip: string): string {
  return ip.trim().toLowerCase() || "unknown";
}
