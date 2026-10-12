import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import {
  DecisionModelRequestError,
  fetchDecisionModel,
  fetchDecisionModelReport,
  saveDecisionModel,
  testDecisionModelConnection,
} from "./mail-decision-model-api";
import {
  decisionModelReportFixture,
  decisionModelViewFixture,
} from "./mail-decision-model.test-fixtures";

function respond(payload: unknown, status = 200): ReturnType<typeof vi.fn<AuthFetch>> {
  return vi.fn<AuthFetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("decision model admin client", () => {
  it("parses the settings view", async () => {
    const fetchImpl = respond({ decisionModel: decisionModelViewFixture() });
    const view = await fetchDecisionModel(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/mail/decision-model", { method: "GET" });
    expect(view.provider).toBe("cloudflare");
    expect(view.credentialConfigured).toBe(true);
    expect(view.notice).toContain("Cloudflare Workers AI");
  });

  it("rejects a malformed view instead of rendering it", async () => {
    const fetchImpl = respond({ decisionModel: { ...decisionModelViewFixture(), mode: "maybe" } });
    await expect(fetchDecisionModel(fetchImpl)).rejects.toThrow(/malformed response/u);
  });

  it("PUTs exactly the settings, key, and clear flag it is given", async () => {
    const fetchImpl = respond({ decisionModel: decisionModelViewFixture() });
    await saveDecisionModel(
      {
        settings: {
          mode: "shadow",
          provider: "cloudflare",
          model: "clef",
          cloudflareAccountId: "0123456789abcdef0123456789abcdef",
          spamThreshold: 0.9,
          phishingThreshold: 0.8,
          categoryThreshold: 0.75,
          applyCategories: false,
          dailyMessageCap: 5000,
        },
        apiKey: "cf-token-123456",
      },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/decision-model");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({
      settings: {
        mode: "shadow",
        provider: "cloudflare",
        model: "clef",
        cloudflareAccountId: "0123456789abcdef0123456789abcdef",
        spamThreshold: 0.9,
        phishingThreshold: 0.8,
        categoryThreshold: 0.75,
        applyCategories: false,
        dailyMessageCap: 5000,
      },
      apiKey: "cf-token-123456",
    });
  });

  it("maps server issues to fields, including issues nested under settings", async () => {
    const fetchImpl = respond(
      {
        error: "Invalid decision model settings.",
        code: "invalid_request",
        issues: [
          {
            path: ["cloudflareAccountId"],
            message: "cloudflareAccountId must be the 32-character account id.",
          },
          {
            path: ["settings", "spamThreshold"],
            message: "Number must be greater than or equal to 0.5",
          },
          { path: [], message: "Send either apiKey or clearApiKey, not both." },
        ],
      },
      400,
    );
    const error = await saveDecisionModel(
      {
        settings: {
          mode: "off",
          provider: "cloudflare",
          spamThreshold: 0.1,
          phishingThreshold: 0.8,
          categoryThreshold: 0.75,
          applyCategories: false,
          dailyMessageCap: 5000,
        },
      },
      fetchImpl,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionModelRequestError);
    const failure = error as DecisionModelRequestError;
    expect(failure.message).toBe("Invalid decision model settings.");
    expect(failure.status).toBe(400);
    expect(failure.fieldErrors).toEqual({
      cloudflareAccountId: "cloudflareAccountId must be the 32-character account id.",
      spamThreshold: "Number must be greater than or equal to 0.5",
    });
  });

  it("returns the connection test result and keeps provider failures actionable", async () => {
    const ok = respond({
      test: {
        ok: true,
        latencyMs: 412,
        model: "clef-flash",
        answer: "legitimate",
        confidence: 0.98,
        provider: "cloudflare",
      },
    });
    const result = await testDecisionModelConnection({ apiKey: "cf-token-123456" }, ok);
    expect(result.latencyMs).toBe(412);
    expect(JSON.parse(ok.mock.calls[0]?.[1]?.body as string)).toEqual({
      apiKey: "cf-token-123456",
    });

    const failed = respond(
      {
        error: "Cloudflare rejected the API token. Check that it has Workers AI permission.",
        code: "provider_error",
        providerCode: "unauthorized",
        providerStatus: 401,
      },
      502,
    );
    const error = await testDecisionModelConnection({}, failed).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionModelRequestError);
    expect((error as DecisionModelRequestError).providerCode).toBe("unauthorized");
    expect((error as Error).message).toContain("Workers AI permission");
  });

  it("requests the report window and parses the report", async () => {
    const fetchImpl = respond({
      report: decisionModelReportFixture(),
      decisionModel: { mode: "shadow", provider: "cloudflare", model: "clef-flash" },
    });
    const result = await fetchDecisionModelReport(7, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/admin/mail/decision-model/report?days=7");
    expect(result.report.feedback.model.falsePositiveRate).toBe(0.0125);
    expect(result.report.disagreements).toHaveLength(1);
  });
});
