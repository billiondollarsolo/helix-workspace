import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseGitHubWebhook,
  parseGitLabWebhook,
  parseGrafanaWebhook,
  parseLinearWebhook,
  parsePrometheusWebhook,
  parseStripeWebhook,
  parseStripeSignatureHeader,
  summarizeGitHubWebhook,
  verifyGitHubWebhookSignature,
  verifyGitLabWebhookSignature,
  verifyGrafanaWebhookSignature,
  verifyLinearWebhookSignature,
  verifyPrometheusWebhookSignature,
  verifyStripeWebhookSignature,
} from "./index.js";

describe("inbound webhook sources", () => {
  it("verifies and parses GitHub webhook deliveries", () => {
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "helix/workspace" },
      commits: [{ id: "abc" }, { id: "def" }],
    });
    const signature = createHmac("sha256", "github_secret").update(payload).digest("hex");

    expect(
      verifyGitHubWebhookSignature({
        payload,
        secret: "github_secret",
        headers: {
          "X-Hub-Signature-256": `sha256=${signature}`,
        },
      }),
    ).toBe(true);
    expect(
      verifyGitHubWebhookSignature({
        payload: `${payload}\n`,
        secret: "github_secret",
        header: `sha256=${signature}`,
      }),
    ).toBe(false);

    const parsed = parseGitHubWebhook({
      payload,
      headers: {
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": "deliv_123",
      },
    });

    expect(parsed).toMatchObject({
      sourceType: "github",
      event: "push",
      deliveryId: "deliv_123",
      repositoryFullName: "helix/workspace",
      ref: "refs/heads/main",
      commitCount: 2,
    });
    expect(summarizeGitHubWebhook(parsed)).toBe(
      "GitHub push to helix/workspace refs/heads/main: 2 commits",
    );
  });

  it("verifies Stripe timestamped v1 signatures and parses events", () => {
    const payload = JSON.stringify({
      id: "evt_123",
      type: "invoice.paid",
      created: 1_777_777_700,
      livemode: false,
      data: {
        object: {
          id: "in_123",
          object: "invoice",
        },
      },
    });
    const timestamp = 1_777_777_777;
    const signature = createHmac("sha256", "whsec_stripe")
      .update(`${String(timestamp)}.${payload}`)
      .digest("hex");
    const header = `t=${String(timestamp)},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${signature}`;

    expect(parseStripeSignatureHeader(header)).toEqual({
      timestamp,
      signatures: ["0000000000000000000000000000000000000000000000000000000000000000", signature],
    });
    expect(
      verifyStripeWebhookSignature({
        payload,
        secret: "whsec_stripe",
        header,
        now: 1_777_777_800,
      }),
    ).toBe(true);
    expect(
      verifyStripeWebhookSignature({
        payload,
        secret: "whsec_stripe",
        header,
        now: 1_777_778_500,
      }),
    ).toBe(false);
    expect(parseStripeWebhook({ payload })).toMatchObject({
      sourceType: "stripe",
      id: "evt_123",
      event: "invoice.paid",
      object: {
        id: "in_123",
      },
    });
  });

  it("verifies and parses Linear webhook deliveries", () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "create",
      organizationId: "org_123",
      webhookId: "wh_123",
      data: {
        id: "issue_123",
        title: "Ship webhooks",
      },
      url: "https://linear.app/helix/issue/HEL-123",
    });
    const signature = createHmac("sha256", "linear_secret").update(payload).digest("hex");

    expect(
      verifyLinearWebhookSignature({
        payload,
        secret: "linear_secret",
        headers: {
          "Linear-Signature": signature,
        },
      }),
    ).toBe(true);
    expect(
      verifyLinearWebhookSignature({
        payload,
        secret: "wrong",
        header: signature,
      }),
    ).toBe(false);
    expect(parseLinearWebhook({ payload })).toMatchObject({
      sourceType: "linear",
      event: "Issue",
      action: "create",
      organizationId: "org_123",
      webhookId: "wh_123",
      data: {
        id: "issue_123",
        title: "Ship webhooks",
      },
    });
  });

  it("verifies and parses GitLab webhook deliveries", () => {
    const payload = JSON.stringify({
      object_kind: "push",
      event_name: "push",
      ref: "refs/heads/main",
      project: { path_with_namespace: "helix/workspace" },
      commits: [{ id: "abc" }, { id: "def" }],
    });

    expect(
      verifyGitLabWebhookSignature({
        payload,
        secret: "gitlab_secret",
        headers: { "X-Gitlab-Token": "gitlab_secret" },
      }),
    ).toBe(true);
    expect(
      verifyGitLabWebhookSignature({
        payload,
        secret: "wrong",
        header: "gitlab_secret",
      }),
    ).toBe(false);
    const signingSecret = `whsec_${Buffer.from("standard_secret").toString("base64url")}`;
    const standardSignature = createHmac("sha256", "standard_secret")
      .update(`msg_123.1777777777.${payload}`)
      .digest("base64");
    expect(
      verifyGitLabWebhookSignature({
        payload,
        secret: signingSecret,
        headers: {
          "webhook-id": "msg_123",
          "webhook-timestamp": "1777777777",
          "webhook-signature": `v1,${standardSignature}`,
        },
      }),
    ).toBe(true);

    expect(
      parseGitLabWebhook({
        payload,
        headers: {
          "X-Gitlab-Event": "Push Hook",
          "X-Gitlab-Event-UUID": "event-123",
        },
      }),
    ).toMatchObject({
      sourceType: "gitlab",
      event: "Push Hook",
      deliveryId: "event-123",
      objectKind: "push",
      projectPath: "helix/workspace",
      ref: "refs/heads/main",
      commitCount: 2,
    });
  });

  it("verifies and parses Grafana alert webhooks", () => {
    const payload = JSON.stringify({
      receiver: "on-call",
      status: "firing",
      orgId: 1,
      alerts: [{ status: "firing" }],
      groupLabels: { alertname: "HighLatency" },
      commonLabels: { severity: "page" },
      title: "[FIRING] HighLatency",
      message: "Latency is high",
    });

    const grafanaSignature = createHmac("sha256", "grafana_secret")
      .update(`1777777777:${payload}`)
      .digest("hex");
    expect(
      verifyGrafanaWebhookSignature({
        payload,
        secret: "grafana_secret",
        headers: {
          "x-grafana-alerting-signature": grafanaSignature,
          "x-grafana-alerting-timestamp": "1777777777",
        },
      }),
    ).toBe(true);
    expect(
      verifyGrafanaWebhookSignature({
        payload,
        secret: "grafana_secret",
        headers: { authorization: "Bearer grafana_secret" },
      }),
    ).toBe(true);
    expect(
      verifyGrafanaWebhookSignature({
        payload,
        secret: "wrong",
        headers: { "x-grafana-webhook-secret": "grafana_secret" },
      }),
    ).toBe(false);

    expect(parseGrafanaWebhook({ payload })).toMatchObject({
      sourceType: "grafana",
      event: "alert.firing",
      receiver: "on-call",
      status: "firing",
      orgId: 1,
      alertCount: 1,
      groupLabels: { alertname: "HighLatency" },
      commonLabels: { severity: "page" },
      title: "[FIRING] HighLatency",
    });
  });

  it("verifies and parses Prometheus Alertmanager webhooks", () => {
    const payload = JSON.stringify({
      version: "4",
      receiver: "web.hook",
      status: "resolved",
      groupKey: '{}:{alertname="DiskFull"}',
      externalURL: "https://alertmanager.example",
      truncatedAlerts: 0,
      alerts: [{ status: "resolved" }, { status: "resolved" }],
      groupLabels: { alertname: "DiskFull" },
      commonLabels: { severity: "warning" },
    });

    expect(
      verifyPrometheusWebhookSignature({
        payload,
        secret: "prometheus_secret",
        headers: { "x-prometheus-alertmanager-token": "prometheus_secret" },
      }),
    ).toBe(true);
    expect(
      verifyPrometheusWebhookSignature({
        payload,
        secret: "wrong",
        headers: { authorization: "Bearer prometheus_secret" },
      }),
    ).toBe(false);

    expect(parsePrometheusWebhook({ payload })).toMatchObject({
      sourceType: "prometheus",
      event: "alerts.resolved",
      receiver: "web.hook",
      status: "resolved",
      groupKey: '{}:{alertname="DiskFull"}',
      externalUrl: "https://alertmanager.example",
      truncatedAlerts: 0,
      alertCount: 2,
    });
  });
});
