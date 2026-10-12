import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { mailAdminQueryKeys } from "./mail-admin-api";

/**
 * Admin client for the AI decision model (Admin → Mail → Spam filtering):
 *  - `GET/PUT /api/admin/mail/decision-model`       — settings (API key is write-only)
 *  - `POST    /api/admin/mail/decision-model/test`  — connection test with unsaved settings
 *  - `GET     /api/admin/mail/decision-model/report` — shadow/enforce accuracy report
 *
 * Responses are validated with Zod at the trust boundary. Failures throw a
 * `DecisionModelRequestError` that keeps the server's actionable message,
 * per-field `issues`, and the provider error code for connection tests.
 */

export const DECISION_MODEL_MODES = ["off", "shadow", "enforce"] as const;
export type DecisionModelMode = (typeof DECISION_MODEL_MODES)[number];

export const DECISION_MODEL_PROVIDERS = ["cloudflare", "typesafe"] as const;
export type DecisionModelProvider = (typeof DECISION_MODEL_PROVIDERS)[number];

export const CLOUDFLARE_DECISION_MODELS = ["clef-flash", "clef"] as const;

/** Each provider's default model; matches the backend's `defaultDecisionModel`. */
export const DEFAULT_DECISION_MODELS: Readonly<Record<DecisionModelProvider, string>> = {
  cloudflare: "clef-flash",
  typesafe: "jev-latest",
};

export const REPORT_WINDOWS = [7, 30, 90] as const;

const decisionModelViewSchema = z.object({
  mode: z.enum(DECISION_MODEL_MODES),
  provider: z.enum(DECISION_MODEL_PROVIDERS),
  model: z.string(),
  defaultModel: z.string(),
  baseUrl: z.string().nullable(),
  cloudflareAccountId: z.string().nullable(),
  spamThreshold: z.number(),
  phishingThreshold: z.number(),
  categoryThreshold: z.number(),
  applyCategories: z.boolean(),
  dailyMessageCap: z.number().int(),
  inputPricePerMillionTokensUsd: z.number().nullable(),
  credentialConfigured: z.boolean(),
  credentialUpdatedAt: z.string().nullable(),
  providerLabel: z.string(),
  endpointHost: z.string(),
  notice: z.string(),
});
export type DecisionModelView = z.infer<typeof decisionModelViewSchema>;

const viewResponseSchema = z.object({ decisionModel: decisionModelViewSchema });

const testResponseSchema = z.object({
  test: z.object({
    ok: z.literal(true),
    latencyMs: z.number(),
    model: z.string(),
    answer: z.string().nullable(),
    confidence: z.number().nullable(),
    provider: z.enum(DECISION_MODEL_PROVIDERS),
  }),
});
export type DecisionModelTestResult = z.infer<typeof testResponseSchema>["test"];

const confusionSchema = z.object({
  labelled: z.number().int(),
  truePositives: z.number().int(),
  falsePositives: z.number().int(),
  trueNegatives: z.number().int(),
  falseNegatives: z.number().int(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  falsePositiveRate: z.number().nullable(),
});
export type DecisionConfusion = z.infer<typeof confusionSchema>;

const actionCountsSchema = z.object({
  none: z.number().int(),
  spam: z.number().int(),
  phishing: z.number().int(),
  category: z.number().int(),
});

const reportSchema = z.object({
  window: z.object({ days: z.number().int(), since: z.string(), until: z.string() }),
  totals: z.object({
    recorded: z.number().int(),
    decided: z.number().int(),
    skipped: z.number().int(),
    error: z.number().int(),
  }),
  outcomes: z.array(
    z.object({ outcome: z.string(), reason: z.string().nullable(), count: z.number().int() }),
  ),
  verdicts: z.object({
    legitimate: z.number().int(),
    spam: z.number().int(),
    phishing: z.number().int(),
    scam: z.number().int(),
  }),
  proposedActions: actionCountsSchema,
  actionsTaken: actionCountsSchema,
  spamAssassin: z.object({
    compared: z.number().int(),
    agree: z.number().int(),
    agreementRate: z.number().nullable(),
    modelOnly: z.number().int(),
    spamAssassinOnly: z.number().int(),
  }),
  feedback: z.object({ model: confusionSchema, spamAssassin: confusionSchema }),
  latency: z.object({ averageMs: z.number().nullable(), p95Ms: z.number().nullable() }),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    averageInputPerMessage: z.number().nullable(),
  }),
  cost: z.object({ estimatedUsd: z.number().nullable(), priced: z.boolean() }),
  disagreements: z.array(
    z.object({
      messageId: z.string(),
      senderDomain: z.string().nullable(),
      verdict: z.string().nullable(),
      confidence: z.number().nullable(),
      userLabel: z.enum(["spam", "ham"]),
      decidedAt: z.string(),
    }),
  ),
});

const reportResponseSchema = z.object({
  report: reportSchema,
  decisionModel: z.object({
    mode: z.enum(DECISION_MODEL_MODES),
    provider: z.enum(DECISION_MODEL_PROVIDERS),
    model: z.string(),
  }),
});
export type DecisionModelReportResponse = z.infer<typeof reportResponseSchema>;
export type DecisionModelReport = DecisionModelReportResponse["report"];

/** The `settings` object the backend accepts (strict; it replaces the stored settings). */
export interface DecisionModelSettingsInput {
  readonly mode: DecisionModelMode;
  readonly provider: DecisionModelProvider;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly cloudflareAccountId?: string;
  readonly spamThreshold: number;
  readonly phishingThreshold: number;
  readonly categoryThreshold: number;
  readonly applyCategories: boolean;
  readonly dailyMessageCap: number;
  readonly inputPricePerMillionTokensUsd?: number;
}

export interface SaveDecisionModelInput {
  readonly settings: DecisionModelSettingsInput;
  /** Write-only; omitted to keep the stored key. */
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
}

export interface TestDecisionModelInput {
  readonly settings?: DecisionModelSettingsInput;
  readonly apiKey?: string;
}

/** A failed decision-model request with everything the form needs to explain it. */
export class DecisionModelRequestError extends Error {
  readonly status: number;
  /** First server message per settings field (`cloudflareAccountId`, `apiKey`, …). */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** The provider's error code for a failed connection test (`unauthorized`, `timeout`, …). */
  readonly providerCode: string | null;

  constructor(
    message: string,
    options: {
      readonly status: number;
      readonly fieldErrors?: Readonly<Record<string, string>>;
      readonly providerCode?: string | null;
    },
  ) {
    super(message);
    this.name = "DecisionModelRequestError";
    this.status = options.status;
    this.fieldErrors = options.fieldErrors ?? {};
    this.providerCode = options.providerCode ?? null;
  }
}

const errorEnvelopeSchema = z.object({
  error: z.string().optional(),
  providerCode: z.string().optional(),
  issues: z
    .array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])).default([]),
        message: z.string(),
      }),
    )
    .optional(),
});

/** Map zod issues to fields. PUT body issues are under `settings.*`; settings issues are bare. */
function fieldErrorsFrom(
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path[0] === "settings" ? issue.path.slice(1) : issue.path;
    const field = path[0];
    if (typeof field === "string" && errors[field] === undefined) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

async function parseDecisionResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(payload);
    const body = envelope.success ? envelope.data : {};
    throw new DecisionModelRequestError(
      body.error ?? `Failed to ${action} (${String(response.status)}).`,
      {
        status: response.status,
        fieldErrors: fieldErrorsFrom(body.issues ?? []),
        providerCode: body.providerCode ?? null,
      },
    );
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new Error(`Failed to ${action}: malformed response.`);
}

const jsonHeaders = { "content-type": "application/json" } as const;

export const decisionModelQueryKeys = {
  settings: () => [...mailAdminQueryKeys.spam(), "decision-model"] as const,
  report: (days: number) =>
    [...mailAdminQueryKeys.spam(), "decision-model", "report", days] as const,
};

export function decisionModelQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: decisionModelQueryKeys.settings(),
    queryFn: () => fetchDecisionModel(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function decisionModelReportQueryOptions(
  days: number,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    queryKey: decisionModelQueryKeys.report(days),
    queryFn: () => fetchDecisionModelReport(days, fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export async function fetchDecisionModel(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DecisionModelView> {
  const response = await fetchImpl("/api/admin/mail/decision-model", { method: "GET" });
  return (
    await parseDecisionResponse(response, "load the AI decision model settings", viewResponseSchema)
  ).decisionModel;
}

export async function saveDecisionModel(
  input: SaveDecisionModelInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DecisionModelView> {
  const response = await fetchImpl("/api/admin/mail/decision-model", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (
    await parseDecisionResponse(response, "save the AI decision model settings", viewResponseSchema)
  ).decisionModel;
}

export async function testDecisionModelConnection(
  input: TestDecisionModelInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DecisionModelTestResult> {
  const response = await fetchImpl("/api/admin/mail/decision-model/test", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseDecisionResponse(response, "test the connection", testResponseSchema)).test;
}

export async function fetchDecisionModelReport(
  days: number,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DecisionModelReportResponse> {
  const params = new URLSearchParams({ days: String(days) });
  const response = await fetchImpl(`/api/admin/mail/decision-model/report?${params.toString()}`, {
    method: "GET",
  });
  return parseDecisionResponse(response, "load the AI decision model report", reportResponseSchema);
}
