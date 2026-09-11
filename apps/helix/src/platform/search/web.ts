import type { AiConfig, AiWebSearchConfig } from "@helix/sdk-types";
import { isIP } from "node:net";
import { z } from "zod";
import { env } from "../../config/env.js";
import { BadRequestError } from "../../api/api-error.js";
import { detectDlp } from "../dlp.js";
import { deriveClassification } from "../ai/classification/index.js";
import {
  createOutboundHttpClient,
  isPublicOutboundAddress,
  OutboundHttpError,
} from "../outbound-http.js";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const querySchema = z.string().trim().min(1).max(1_000);
const resultSchema = z.object({
  url: z.string().max(2_048),
  title: z.string().max(10_000),
  description: z.string().max(100_000).optional(),
  content: z.string().max(100_000).optional(),
});
export const webSearchResultSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        url: z.string().url(),
        snippet: z.string(),
      }),
    )
    .max(10),
  provider: z.enum(["brave", "searxng"]),
});
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

export function getWebSearchEnabled(ai: AiConfig | undefined): boolean {
  if (ai?.enabled === false || ai?.webSearch?.enabled !== true) return false;
  try {
    providerEndpoint(ai.webSearch);
    return true;
  } catch {
    return false;
  }
}

/** Public search sends only the selected query; it never uploads the conversation or files. */
export async function searchWeb(
  config: AiWebSearchConfig | undefined,
  query: string,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): Promise<WebSearchResult> {
  options.signal?.throwIfAborted();
  if (config?.enabled !== true)
    throw new BadRequestError("Web search is disabled by the administrator.");
  const text = querySchema.parse(query);
  const classification = deriveClassification({ content: text, scanContent: true }).classification;
  if (
    classification === "confidential" ||
    classification === "restricted" ||
    /\bconfidential\b/i.test(text) ||
    detectDlp(text, new Set(["credentials", "pii", "credit_card"])).length > 0
  )
    throw new BadRequestError(
      "Web search cannot send sensitive queries to an external search provider.",
    );
  const url = providerEndpoint(config);
  const maxResults = z
    .number()
    .int()
    .min(1)
    .max(10)
    .parse(config.maxResults ?? 5);
  url.searchParams.set("q", text);
  const headers = new Headers({ accept: "application/json" });
  if (config.provider === "brave") {
    url.searchParams.set("count", String(maxResults));
    url.searchParams.set("text_decorations", "false");
    headers.set("X-Subscription-Token", (config.apiKey ?? "").trim());
  } else {
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    if (config.apiKey?.trim()) headers.set("Authorization", `Bearer ${config.apiKey.trim()}`);
  }
  // A configured self-hosted engine may be private. Search-result URLs are never fetched
  // through this exception, and redirects cannot forward the query or credentials.
  const send =
    options.fetch ??
    createOutboundHttpClient({
      allowedHosts: [url.hostname],
      allowHttp: url.protocol === "http:",
      allowPrivateNetwork:
        config.provider === "searxng" && env().HELIX_AI_ALLOW_PRIVATE_NETWORK === "true",
      maxRedirects: 0,
      timeoutMs: 10_000,
      maxResponseBytes: 1_048_576,
    });
  let raw: unknown;
  try {
    const response = await send(url, {
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BadRequestError(
        response.status === 401 || response.status === 403
          ? "Web search authentication failed. Check the saved key and, for SearXNG, enable JSON responses."
          : response.status === 429
            ? "The web search provider is rate limited. Try again later."
            : `Web search provider returned HTTP ${String(response.status)}. Check its connection in Admin.`,
      );
    }
    raw = await response.json();
    options.signal?.throwIfAborted();
  } catch (error) {
    // Caller cancellation is not a provider outage. Never forward remote URLs, bodies, or errors.
    options.signal?.throwIfAborted();
    if (error instanceof BadRequestError) throw error;
    if (error instanceof SyntaxError)
      throw new BadRequestError(
        "Web search returned an unreadable response. Check the provider's JSON API.",
      );
    if (error instanceof OutboundHttpError) {
      if (error.code === "blocked_destination")
        throw new BadRequestError(
          "The search provider destination or redirect is blocked by network policy. Check its endpoint and network settings in Admin.",
        );
      if (error.code === "aborted")
        throw new BadRequestError("The web search provider timed out. Try again later.");
      if (error.code === "dns_failed")
        throw new BadRequestError(
          "The search provider hostname could not be resolved. Check its endpoint and DNS settings.",
        );
      if (error.code === "response_too_large")
        throw new BadRequestError("The search provider response exceeds the 1 MiB limit.");
    }
    throw new BadRequestError(
      "Could not reach the web search provider. Check its connection in Admin and try again.",
    );
  }
  const parsed = (
    config.provider === "brave"
      ? z
          .object({ web: z.object({ results: resultSchema.array().max(100) }).optional() })
          .transform((value) => value.web?.results ?? [])
      : z.object({ results: resultSchema.array().max(1_000) }).transform((value) => value.results)
  ).safeParse(raw);
  if (!parsed.success)
    throw new BadRequestError(
      "Web search returned an unexpected response. Check the provider configuration.",
    );
  const seen = new Set<string>();
  const results: WebSearchResult["results"] = [];
  for (const item of parsed.data) {
    const link = publicResultUrl(item.url);
    if (link === undefined || seen.has(link)) continue;
    seen.add(link);
    results.push({
      id: `web-${String(results.length + 1)}`,
      url: link,
      title: plainSnippet(item.title, 180),
      snippet: plainSnippet(item.description ?? item.content ?? "", 500),
    });
    if (results.length >= maxResults) break;
  }
  return { provider: config.provider === "brave" ? "brave" : "searxng", results };
}

export async function testWebSearch(
  config: AiWebSearchConfig | undefined,
  options: { readonly fetch?: typeof fetch } = {},
) {
  const start = Date.now();
  try {
    const result = await searchWeb(
      { ...config, enabled: true },
      "web search connection test",
      options,
    );
    return {
      ok: result.results.length > 0,
      message:
        result.results.length > 0
          ? "Search API responded with valid results."
          : "Search API responded but returned no usable public results. Check upstream engine availability and retry the connection test.",
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof BadRequestError
          ? error.message
          : "Web search connection failed. Check the endpoint, credentials, and network policy.",
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
    };
  }
}

function providerEndpoint(config: AiWebSearchConfig): URL {
  if (config.provider === "brave") {
    if (!config.apiKey?.trim()) throw new BadRequestError("A Brave Search API key is required.");
    return new URL(BRAVE_URL);
  }
  if (config.provider !== "searxng" || !config.baseUrl?.trim())
    throw new BadRequestError("Choose a web search provider and configure its endpoint.");
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new BadRequestError("Enter a valid SearXNG HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BadRequestError(
      "The SearXNG endpoint must be an HTTP or HTTPS URL without credentials, query, or fragment.",
    );
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/search$/, "")}/search`;
  return url;
}

export function publicResultUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (isIP(host)
        ? !isPublicOutboundAddress(host)
        : !host.includes(".") || /\.(localhost|local|internal|home\.arpa)$/i.test(host))
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function plainSnippet(value: string, limit: number): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
