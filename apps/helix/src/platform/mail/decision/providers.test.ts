import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDecisionModelConfig } from "./config.js";
import {
  DecisionModelError,
  validateDecisionRequest,
  type DecisionQuestion,
  type DecisionRequest,
} from "./protocol.js";
import { createDecisionModelProvider, probeDecisionModel } from "./providers.js";

const accountId = "0123456789abcdef0123456789abcdef";
const request: DecisionRequest = {
  state: "Hi, the Stripe integration keeps failing. Please help ASAP.",
  instructions: "Classify this support email.",
  questions: {
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: { billing: "Payments", technical: "Bugs", sales: null },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["calm", "frustrated", "angry"],
    },
    urgent: { type: "noul", instructions: "Is it urgent?" },
  },
};

const jevBody = {
  model: "jev-1.13.0",
  answers: {
    department: {
      type: "choice",
      choice: "technical",
      confidence: 0.78,
      probabilities: { technical: 0.85, sales: 0.0, billing: 0.15 },
    },
    frustration: {
      type: "score",
      score: 1.2,
      confidence: 0.4,
      legend: { "0": "calm", "1": "frustrated", "2": "angry" },
      probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
    },
    urgent: { type: "noul", noul: 0.2 },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function recordingFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit; body: string }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      init: init ?? {},
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const typesafe = resolveDecisionModelConfig({ mode: "shadow", provider: "typesafe" });
const cloudflare = resolveDecisionModelConfig({
  mode: "shadow",
  provider: "cloudflare",
  cloudflareAccountId: accountId,
});
const noSleep = async () => undefined;

afterEach(() => {
  vi.useRealTimers();
});

describe("TypeSafe adapter", () => {
  it("posts the exact System One body and recomputes confidence from probabilities", async () => {
    const { calls, fetchImpl } = recordingFetch(
      jsonResponse(jevBody, 200, { "x-typesafe-request-id": "req_1" }),
    );
    const provider = createDecisionModelProvider(typesafe, "ts-secret-key", { fetch: fetchImpl });
    const result = await provider.decide(request);

    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ts-secret-key");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      model: "jev-latest",
      state: request.state,
      questions: {
        department: {
          type: "choice",
          instructions: "Classify this support email.\nWhich team should handle this?",
          criteria: { billing: "Payments", technical: "Bugs", sales: null },
        },
        frustration: {
          type: "score",
          instructions: "Classify this support email.\nHow frustrated is the customer?",
          criteria: ["calm", "frustrated", "angry"],
        },
        urgent: { type: "noul", instructions: "Classify this support email.\nIs it urgent?" },
      },
    });
    expect(result).toEqual({
      model: "jev-1.13.0",
      requestId: "req_1",
      usage: { inputTokens: 392, outputTokens: 65 },
      answers: {
        // Vendor confidence 0.78 is ignored: top-option probability is 0.85.
        department: {
          type: "choice",
          answer: "technical",
          probabilities: { billing: 0.15, technical: 0.85, sales: 0 },
          confidence: 0.85,
        },
        frustration: {
          type: "score",
          answer: "frustrated",
          probabilities: { calm: 0.1, frustrated: 0.6, angry: 0.3 },
          confidence: 0.6,
        },
        urgent: {
          type: "noul",
          answer: false,
          probabilities: { true: 0.2, false: 0.8 },
          confidence: 0.8,
        },
      },
    });
  });

  it("keeps a noul answer without a probability as unknown", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ ...jevBody, answers: { ...jevBody.answers, urgent: { type: "noul" } } }),
    );
    const result = await createDecisionModelProvider(typesafe, "k".repeat(10), {
      fetch: fetchImpl,
    }).decide(request);
    expect(result.answers.urgent).toEqual({
      type: "noul",
      answer: null,
      probabilities: {},
      confidence: null,
    });
  });

  it("accepts the Vercel-native noul `probability` and an OpenRouter base URL", async () => {
    const { calls, fetchImpl } = recordingFetch(
      jsonResponse({
        ...jevBody,
        answers: { ...jevBody.answers, urgent: { type: "boolean", probability: 0.9 } },
      }),
    );
    const config = resolveDecisionModelConfig({
      provider: "typesafe",
      baseUrl: "https://openrouter.ai/api/",
      model: "~typesafe/jev-latest",
    });
    const result = await createDecisionModelProvider(config, "k".repeat(10), {
      fetch: fetchImpl,
    }).decide(request);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(JSON.parse(calls[0]?.body ?? "").model).toBe("~typesafe/jev-latest");
    expect(result.answers.urgent?.confidence).toBe(0.9);
  });

  it("maps 401, 403, and 422 without retrying and keeps vendor detail", async () => {
    const auth = recordingFetch(
      jsonResponse(
        { detail: { error_type: "authentication_error", message: "Cannot authenticate" } },
        401,
      ),
    );
    await expect(
      createDecisionModelProvider(typesafe, "bad-key-123", { fetch: auth.fetchImpl }).decide(
        request,
      ),
    ).rejects.toMatchObject({ code: "authentication", options: { status: 401 } });
    expect(auth.calls).toHaveLength(1);

    const missing = recordingFetch(jsonResponse({ detail: { message: "Must supply" } }, 403));
    await expect(
      createDecisionModelProvider(typesafe, "bad-key-123", { fetch: missing.fetchImpl }).decide(
        request,
      ),
    ).rejects.toMatchObject({ code: "authentication" });

    const invalid = recordingFetch(
      jsonResponse(
        { detail: [{ loc: ["body", "state"], msg: "Field required", type: "missing" }] },
        422,
      ),
    );
    const error = await createDecisionModelProvider(typesafe, "key-12345", {
      fetch: invalid.fetchImpl,
    })
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionModelError);
    expect((error as DecisionModelError).code).toBe("invalid_request");
    expect((error as Error).message).toContain("body.state: Field required");
    expect(invalid.calls).toHaveLength(1);
  });

  it("retries 429 and 529 with backoff, honouring retry-after, at most twice", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const limited = recordingFetch(
      jsonResponse({}, 429, { "retry-after": "2" }),
      jsonResponse({}, 529),
      jsonResponse(jevBody),
    );
    await createDecisionModelProvider(typesafe, "key-12345", {
      fetch: limited.fetchImpl,
      sleep,
    }).decide(request);
    expect(limited.calls).toHaveLength(3);
    expect(delays).toEqual([2000, 1000]);

    const overloaded = recordingFetch(
      jsonResponse({}, 529),
      jsonResponse({}, 503),
      jsonResponse({}, 500),
    );
    await expect(
      createDecisionModelProvider(typesafe, "key-12345", {
        fetch: overloaded.fetchImpl,
        sleep,
      }).decide(request),
    ).rejects.toMatchObject({ code: "provider_unavailable", options: { status: 500 } });
    expect(overloaded.calls).toHaveLength(3);
  });

  it("waits with real timers between retries (fake clock)", async () => {
    vi.useFakeTimers();
    const network = recordingFetch(new TypeError("fetch failed"), jsonResponse(jevBody));
    const pending = createDecisionModelProvider(typesafe, "key-12345", {
      fetch: network.fetchImpl,
    }).decide(request);
    await vi.advanceTimersByTimeAsync(499);
    expect(network.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ model: "jev-1.13.0" });
    expect(network.calls).toHaveLength(2);
  });

  it("does not retry other 4xx responses", async () => {
    const badRequest = recordingFetch(jsonResponse({ message: "nope" }, 400));
    await expect(
      createDecisionModelProvider(typesafe, "key-12345", {
        fetch: badRequest.fetchImpl,
        sleep: noSleep,
      }).decide(request),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(badRequest.calls).toHaveLength(1);
  });

  it("only reaches the configured host through the hardened outbound client", async () => {
    const local = resolveDecisionModelConfig({
      provider: "typesafe",
      baseUrl: "https://localhost:8443",
    });
    await expect(
      createDecisionModelProvider(local, "key-12345", { sleep: noSleep }).decide(request),
    ).rejects.toMatchObject({ code: "blocked_destination" });
    const privateIp = resolveDecisionModelConfig({
      provider: "typesafe",
      baseUrl: "https://10.0.0.5",
    });
    await expect(
      createDecisionModelProvider(privateIp, "key-12345", { sleep: noSleep }).decide(request),
    ).rejects.toMatchObject({ code: "blocked_destination" });
  });
});

describe("Cloudflare Workers AI adapter", () => {
  it("posts to the account model URL with the model field and parses the result envelope", async () => {
    const { calls, fetchImpl } = recordingFetch(
      jsonResponse({ result: jevBody, success: true, errors: [], messages: [] }),
    );
    const result = await createDecisionModelProvider(cloudflare, "cf-token-123", {
      fetch: fetchImpl,
    }).decide(request);
    expect(calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`,
    );
    const body = JSON.parse(calls[0]?.body ?? "") as {
      model: string;
      questions: Record<string, { instructions: string }>;
    };
    expect(body.model).toBe("clef-flash");
    expect(Object.values(body.questions).every((q) => q.instructions.length > 0)).toBe(true);
    expect(result.answers.department?.answer).toBe("technical");
  });

  it("accepts an unwrapped body and maps the errors[] envelope", async () => {
    const unwrapped = recordingFetch(jsonResponse(jevBody));
    const clef = resolveDecisionModelConfig({
      provider: "cloudflare",
      model: "clef",
      cloudflareAccountId: accountId,
    });
    await expect(
      createDecisionModelProvider(clef, "cf-token-123", { fetch: unwrapped.fetchImpl }).decide(
        request,
      ),
    ).resolves.toMatchObject({ model: "jev-1.13.0" });
    expect(unwrapped.calls[0]?.url).toMatch(/@cf\/cloudflare\/clef$/u);

    const auth = recordingFetch(
      jsonResponse(
        {
          result: null,
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          messages: [],
        },
        401,
      ),
    );
    const error = (await createDecisionModelProvider(cloudflare, "cf-token-123", {
      fetch: auth.fetchImpl,
    })
      .decide(request)
      .catch((caught: unknown) => caught)) as DecisionModelError;
    expect(error.code).toBe("authentication");
    expect(error.message).toContain("Workers AI Read and Edit");
    expect(error.message).not.toContain("cf-token-123");

    const failed = recordingFetch(
      jsonResponse({ result: null, success: false, errors: [{ code: 5006, message: "bad" }] }),
    );
    await expect(
      createDecisionModelProvider(cloudflare, "cf-token-123", { fetch: failed.fetchImpl }).decide(
        request,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects a response that misses a question", async () => {
    const partial = recordingFetch(
      jsonResponse({ result: { ...jevBody, answers: { department: jevBody.answers.department } } }),
    );
    await expect(
      createDecisionModelProvider(cloudflare, "cf-token-123", { fetch: partial.fetchImpl }).decide(
        request,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("request validation", () => {
  const choice = (count: number): DecisionQuestion => ({
    type: "choice",
    instructions: "Pick one",
    criteria: Object.fromEntries(
      Array.from({ length: count }, (_unused, index) => [`o${String(index)}`, null]),
    ),
  });
  const withQuestions = (questions: Record<string, DecisionQuestion>): DecisionRequest => ({
    ...request,
    questions,
  });

  it.each([
    ["no questions", withQuestions({})],
    [
      "65 questions",
      withQuestions(
        Object.fromEntries(Array.from({ length: 65 }, (_u, i) => [`q${String(i)}`, choice(2)])),
      ),
    ],
    ["a bad id", withQuestions({ "bad id": choice(2) })],
    ["a one-option choice", withQuestions({ q: choice(1) })],
    ["256 options", withQuestions({ q: choice(256) })],
    [
      "duplicate options after case folding",
      withQuestions({
        q: { type: "choice", instructions: "x", criteria: { Spam: null, spam: null } },
      }),
    ],
    [
      "eleven score levels",
      withQuestions({
        q: {
          type: "score",
          instructions: "x",
          criteria: Array.from({ length: 11 }, (_u, i) => `l${String(i)}`),
        },
      }),
    ],
    ["empty question instructions", withQuestions({ q: { type: "noul", instructions: " " } })],
    ["empty task instructions", { ...request, instructions: "" }],
  ])("rejects %s", (_label, invalid) => {
    expect(() => {
      validateDecisionRequest(invalid);
    }).toThrow(DecisionModelError);
  });

  it("accepts the limits themselves", () => {
    expect(() => {
      validateDecisionRequest(
        withQuestions({
          ...Object.fromEntries(
            Array.from({ length: 63 }, (_u, i) => [`q${String(i)}`, choice(2)]),
          ),
          wide: choice(255),
        }),
      );
    }).not.toThrow();
  });

  it("validates before calling the provider", async () => {
    const { calls, fetchImpl } = recordingFetch(jsonResponse(jevBody));
    await expect(
      createDecisionModelProvider(typesafe, "key-12345", { fetch: fetchImpl }).decide(
        withQuestions({}),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("probeDecisionModel", () => {
  it("reports latency, resolved model, and the answer", async () => {
    const provider = {
      id: "typesafe" as const,
      model: "jev-latest",
      decide: vi.fn().mockResolvedValue({
        model: "jev-1.13.0",
        usage: { inputTokens: 40, outputTokens: 0 },
        answers: {
          verdict: {
            type: "choice",
            answer: "legitimate",
            probabilities: { legitimate: 0.97, spam: 0.03 },
            confidence: 0.97,
          },
        },
      }),
    };
    let tick = 1000;
    const result = await probeDecisionModel(provider, () => (tick += 120));
    expect(result).toEqual({
      ok: true,
      latencyMs: 120,
      model: "jev-1.13.0",
      answer: "legitimate",
      confidence: 0.97,
    });
    expect(Object.keys(provider.decide.mock.calls[0]?.[0].questions as object)).toEqual([
      "verdict",
    ]);
  });
});
