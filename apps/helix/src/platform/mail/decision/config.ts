import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Per-org decision-model settings, stored as the `mail_decision_model` key of
 * the tenant feature flags so every change is versioned by the tenant-config
 * audit trigger. The API key or token is never part of this object: it lives
 * encrypted in `mail_decision_model_credentials`.
 */

export const DECISION_MODEL_FLAG = "mail_decision_model";

const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";

const decisionModelProviders = ["cloudflare", "typesafe"] as const;
export type DecisionModelProviderId = (typeof decisionModelProviders)[number];

const thresholdSchema = z.number().min(0.5).max(1);

const baseUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "baseUrl must be an https URL without credentials, query, or fragment.");

export const mailDecisionModelConfigSchema = z
  .object({
    mode: z.enum(["off", "shadow", "enforce"]).default("off"),
    provider: z.enum(decisionModelProviders).default("cloudflare"),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9~][A-Za-z0-9._~/-]{0,99}$/u, "model must be a provider model id.")
      .optional(),
    baseUrl: baseUrlSchema.optional(),
    cloudflareAccountId: z
      .string()
      .trim()
      .regex(/^[A-Fa-f0-9]{32}$/u, "cloudflareAccountId must be the 32-character account id.")
      .optional(),
    spamThreshold: thresholdSchema.default(0.9),
    phishingThreshold: thresholdSchema.default(0.8),
    categoryThreshold: thresholdSchema.default(0.75),
    applyCategories: z.boolean().default(false),
    dailyMessageCap: z.number().int().min(1).max(1_000_000).default(5000),
    /** Optional price override (USD per million input tokens) for the report's cost estimate. */
    inputPricePerMillionTokensUsd: z.number().min(0).max(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "cloudflare") {
      if (value.baseUrl !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baseUrl"],
          message: "baseUrl is only supported for the TypeSafe provider.",
        });
      }
      if (value.model !== undefined && value.model !== "clef" && value.model !== "clef-flash") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["model"],
          message: 'Cloudflare model must be "clef" or "clef-flash".',
        });
      }
      if (value.mode !== "off" && value.cloudflareAccountId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cloudflareAccountId"],
          message: "cloudflareAccountId is required to use Cloudflare Workers AI.",
        });
      }
    }
  });

type MailDecisionModelConfig = z.output<typeof mailDecisionModelConfigSchema>;

/** Effective settings with the provider's default model filled in. */
export interface ResolvedDecisionModelConfig extends MailDecisionModelConfig {
  readonly model: string;
}

/** Parse the stored flag; anything missing or invalid means "off". */
export function resolveDecisionModelConfig(stored: unknown): ResolvedDecisionModelConfig {
  const parsed = mailDecisionModelConfigSchema.safeParse(stored ?? {});
  const config = parsed.success ? parsed.data : mailDecisionModelConfigSchema.parse({});
  return { ...config, model: config.model ?? defaultDecisionModel(config.provider) };
}

export function defaultDecisionModel(provider: DecisionModelProviderId): string {
  return provider === "cloudflare" ? "clef-flash" : "jev-latest";
}

/** Short stable fingerprint of the settings that shape a verdict. */
export function decisionConfigVersion(config: ResolvedDecisionModelConfig): string {
  const shape = [
    config.provider,
    config.model,
    config.baseUrl ?? "",
    config.spamThreshold,
    config.phishingThreshold,
    config.categoryThreshold,
    config.applyCategories,
  ];
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/** The endpoint the provider adapter calls; its host is the exact outbound allowlist. */
export function decisionModelEndpoint(config: ResolvedDecisionModelConfig): URL {
  if (config.provider === "cloudflare") {
    return new URL(
      `https://${CLOUDFLARE_API_HOST}/client/v4/accounts/${config.cloudflareAccountId ?? ""}/ai/run/@cf/cloudflare/${config.model}`,
    );
  }
  const base = (config.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/u, "");
  return new URL(`${base}/v1/systemone`);
}

/** Display name used in the admin notice ("Message content is sent to …"). */
export function decisionProviderLabel(provider: DecisionModelProviderId): string {
  return provider === "cloudflare" ? "Cloudflare Workers AI" : "TypeSafe";
}

/**
 * Published list prices in USD per million input tokens (output tokens are
 * free on both providers). Sources: docs.typesafe.ai/models.md and the
 * Workers AI pricing page, 2026-10-12.
 */
const INPUT_PRICE_PER_MILLION_USD: Readonly<Record<string, number>> = {
  "cloudflare:clef": 0.24,
  "cloudflare:clef-flash": 0.038,
  "typesafe:jev": 0.042,
};

export function decisionInputPricePerMillion(
  provider: string,
  model: string,
  config?: ResolvedDecisionModelConfig,
): number | null {
  if (
    config?.inputPricePerMillionTokensUsd !== undefined &&
    config.provider === provider &&
    config.model === model
  ) {
    return config.inputPricePerMillionTokensUsd;
  }
  if (provider === "cloudflare") {
    return INPUT_PRICE_PER_MILLION_USD[`cloudflare:${model.split("/").at(-1) ?? model}`] ?? null;
  }
  return /jev/u.test(model) ? (INPUT_PRICE_PER_MILLION_USD["typesafe:jev"] ?? null) : null;
}
