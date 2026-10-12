import { isRecord } from "../../util/json.js";

/**
 * Provider-neutral decision-model protocol ("System One" wire shape).
 *
 * TypeSafe Jev, Cloudflare Workers AI Clef, OpenRouter, and self-hosted SGLang
 * all speak the same request: a `state` plus typed `questions`, answered with a
 * probability for every option in one pass. Requests are validated against the
 * strictest limits any of them enforces, and every answer's confidence is
 * recomputed here from the returned probabilities because the vendors' own
 * confidence formulas differ and are not comparable.
 */

export type DecisionQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] }
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true?: string; readonly false?: string } | undefined;
    };

export interface DecisionRequest {
  /** The thing being judged, as compact text. */
  readonly state: string;
  /** Task framing sent with every question (questions are scored independently). */
  readonly instructions: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export interface DecisionAnswer {
  readonly type: DecisionQuestion["type"];
  /** Top option (choice), top level label (score), or yes/no (noul); null when unknown. */
  readonly answer: string | boolean | null;
  /** Option name (choice), level label (score), or "true"/"false" (noul) to probability. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Top-option probability; for noul max(p, 1 - p). Null when probabilities are missing. */
  readonly confidence: number | null;
}

export interface DecisionResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly requestId?: string | undefined;
}

export type DecisionModelErrorCode =
  | "invalid_request"
  | "authentication"
  | "rate_limited"
  | "overloaded"
  | "provider_unavailable"
  | "timeout"
  | "invalid_response"
  | "blocked_destination";

/** A provider failure with an actionable, secret-free message. */
export class DecisionModelError extends Error {
  constructor(
    readonly code: DecisionModelErrorCode,
    message: string,
    readonly options: { readonly status?: number | undefined; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "DecisionModelError";
  }

  get retryable(): boolean {
    return this.options.retryable === true;
  }
}

const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
const MAX_QUESTIONS = 64;

/** Reject requests any supported provider would refuse, before spending a call. */
export function validateDecisionRequest(request: DecisionRequest): void {
  const fail = (message: string): never => {
    throw new DecisionModelError("invalid_request", message);
  };
  if (request.state.trim().length === 0) fail("Decision state must not be empty.");
  if (request.instructions.trim().length === 0) fail("Decision instructions must not be empty.");
  const entries = Object.entries(request.questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) {
    fail(`A decision request needs 1 to ${String(MAX_QUESTIONS)} questions.`);
  }
  for (const [id, question] of entries) {
    if (!QUESTION_ID.test(id)) fail(`Question id "${id}" must match [A-Za-z0-9_.-]{1,100}.`);
    if (question.instructions.trim().length === 0) {
      fail(`Question "${id}" needs non-empty instructions.`);
    }
    if (question.type === "choice") {
      assertOptions(id, Object.keys(question.criteria), 2, 255, "choice options", fail);
    } else if (question.type === "score") {
      assertOptions(id, question.criteria, 2, 10, "score levels", fail);
    }
  }
}

function assertOptions(
  id: string,
  options: readonly string[],
  min: number,
  max: number,
  label: string,
  fail: (message: string) => never,
): void {
  if (options.length < min || options.length > max) {
    fail(`Question "${id}" needs ${String(min)} to ${String(max)} ${label}.`);
  }
  const folded = new Set(options.map((option) => option.trim().toLowerCase()));
  if (options.some((option) => option.trim().length === 0) || folded.size !== options.length) {
    fail(`Question "${id}" has empty or duplicate ${label}.`);
  }
}

/** Wire body for `POST /v1/systemone` (TypeSafe shape, shared by Clef). */
export function systemOneRequestBody(
  request: DecisionRequest,
  model: string,
): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const instructions = `${request.instructions.trim()}\n${question.instructions.trim()}`;
    questions[id] =
      question.type === "noul" && question.criteria === undefined
        ? { type: "noul", instructions }
        : { type: question.type, instructions, criteria: question.criteria };
  }
  return { model, state: request.state, questions };
}

/** Parse a System One response body into canonical answers. */
export function parseSystemOneResponse(
  request: DecisionRequest,
  body: unknown,
  fallbackModel: string,
): DecisionResult {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new DecisionModelError(
      "invalid_response",
      "The decision model returned a response without answers.",
    );
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = body.answers[id];
    if (!isRecord(raw)) {
      throw new DecisionModelError(
        "invalid_response",
        `The decision model did not answer question "${id}".`,
      );
    }
    answers[id] = normalizeAnswer(question, raw);
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    model: typeof body.model === "string" && body.model.length > 0 ? body.model : fallbackModel,
    answers,
    usage: {
      inputTokens: tokenCount(usage.input_tokens ?? usage.inputTokens),
      outputTokens: tokenCount(usage.output_tokens ?? usage.outputTokens),
    },
  };
}

function normalizeAnswer(question: DecisionQuestion, raw: Record<string, unknown>): DecisionAnswer {
  if (question.type === "noul") {
    // TypeSafe/Clef return `noul`; Vercel-native returns `probability`.
    const p = probability(raw.noul ?? raw.probability);
    return p === null
      ? { type: "noul", answer: null, probabilities: {}, confidence: null }
      : {
          type: "noul",
          answer: p >= 0.5,
          probabilities: { true: p, false: round(1 - p) },
          confidence: round(Math.max(p, 1 - p)),
        };
  }
  const options =
    question.type === "choice" ? Object.keys(question.criteria) : [...question.criteria];
  const probabilities: Record<string, number> = {};
  const rawProbabilities = isRecord(raw.probabilities) ? raw.probabilities : {};
  options.forEach((option, index) => {
    // Score probabilities are keyed by level index ("0".."n-1").
    const value = probability(
      question.type === "score" ? rawProbabilities[String(index)] : rawProbabilities[option],
    );
    if (value !== null) probabilities[option] = value;
  });
  const top = Object.entries(probabilities).reduce<readonly [string, number] | null>(
    (best, entry) => (best === null || entry[1] > best[1] ? entry : best),
    null,
  );
  if (top !== null) {
    return { type: question.type, answer: top[0], probabilities, confidence: top[1] };
  }
  const fallback =
    question.type === "choice"
      ? typeof raw.choice === "string" && options.includes(raw.choice)
        ? raw.choice
        : null
      : typeof raw.score === "number"
        ? (options[Math.round(raw.score)] ?? null)
        : null;
  return { type: question.type, answer: fallback, probabilities: {}, confidence: null };
}

function probability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? round(Math.min(1, Math.max(0, value)))
    : null;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
