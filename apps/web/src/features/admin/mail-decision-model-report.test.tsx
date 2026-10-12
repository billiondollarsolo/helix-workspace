// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, mount, unmountAll } from "@/test/ui";
import type { DecisionModelReport } from "./mail-decision-model-api";
import { DecisionModelReportPanel } from "./mail-decision-model-report";
import { decisionModelReportFixture, emptyFeedback } from "./mail-decision-model.test-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let report: DecisionModelReport;
let urls: string[];

async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeout) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
}

beforeEach(() => {
  report = decisionModelReportFixture();
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const days = Number(new URL(url, "http://localhost").searchParams.get("days"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            report: { ...report, window: { ...report.window, days } },
            decisionModel: { mode: "shadow", provider: "cloudflare", model: "clef-flash" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(
    <QueryClientProvider client={client}>
      <DecisionModelReportPanel />
    </QueryClientProvider>,
  );
}

function table(name: string): HTMLTableElement {
  const found = document.querySelector<HTMLTableElement>(`table[aria-label="${name}"]`);
  if (found === null) throw new Error(`No table ${name}`);
  return found;
}

describe("DecisionModelReportPanel", () => {
  it("renders totals, agreement, the feedback table, cost and disagreements", async () => {
    renderReport();
    await waitFor(() => expect(document.body.textContent).toContain("Messages classified"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("1,200");
    expect(text).toContain("97.5%"); // SpamAssassin agreement
    expect(text).toContain("380 ms");
    expect(text).toContain("p95 910 ms");
    expect(text).toContain("$0.0547");

    const feedback = table("Accuracy against people's feedback");
    const rows = [...feedback.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("AI decision model");
    expect(rows[0]).toContain("1.3%"); // model false-positive rate
    expect(rows[0]).toContain("97.3%");
    expect(rows[1]).toContain("SpamAssassin");
    expect(rows[1]).toContain("3.9%");
    // The false-positive rate is emphasised.
    expect(feedback.querySelector("tbody strong")?.textContent).toBe("1.3%");

    const skipped = table("Skipped and failed messages").textContent ?? "";
    expect(skipped).toContain("Labelled restricted (never sent)");
    expect(skipped).toContain("Provider timed out");

    const disagreements = table("Where people disagreed with the model").textContent ?? "";
    expect(disagreements).toContain("newsletters.example");
    expect(disagreements).toContain("spam (91%)");
    expect(disagreements).toContain("Not spam");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("says there is not enough feedback yet when nothing is labelled", async () => {
    report = decisionModelReportFixture({ feedback: emptyFeedback, disagreements: [] });
    renderReport();
    await waitFor(() => expect(document.body.textContent).toContain("Not enough feedback yet"));
    expect(
      document.querySelector('table[aria-label="Accuracy against people\'s feedback"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain("No disagreements in this window.");
  });

  it("shows per-filter 'not enough feedback' when only SpamAssassin has labels", async () => {
    report = decisionModelReportFixture({
      feedback: {
        model: emptyFeedback.model,
        spamAssassin: decisionModelReportFixture().feedback.spamAssassin,
      },
    });
    renderReport();
    await waitFor(() => expect(document.body.textContent).toContain("Messages classified"));
    const rows = [...table("Accuracy against people's feedback").querySelectorAll("tbody tr")];
    expect(rows[0]?.textContent).toContain("Not enough feedback yet");
    expect(rows[1]?.textContent).toContain("3.9%");
  });

  it("explains an empty window", async () => {
    report = decisionModelReportFixture({
      totals: { recorded: 0, decided: 0, skipped: 0, error: 0 },
      outcomes: [],
    });
    renderReport();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No mail was sent to the model in the last 30 days.",
      ),
    );
  });

  it("reloads for the chosen window", async () => {
    renderReport();
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain("days=30");
    const select = [...document.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Report window"))
      ?.querySelector("select");
    if (select === null || select === undefined) throw new Error("No window select");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "7");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await waitFor(() => expect(urls.at(-1)).toContain("days=7"));
  });
});
