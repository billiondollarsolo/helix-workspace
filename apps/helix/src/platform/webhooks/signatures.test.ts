import { describe, expect, it } from "vitest";
import {
  parseWebhookSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./signatures.js";

describe("webhook HMAC signatures", () => {
  it("signs payload bytes with a timestamped v1 HMAC header", () => {
    const signed = signWebhookPayload({
      payload: JSON.stringify({ ok: true }),
      secret: "whsec_test",
      timestamp: 1_777_777_777,
    });

    expect(signed).toEqual({
      timestamp: 1_777_777_777,
      signature: "c26d1741d8b72c6da2c6c1661f32ba08cf3b29bc328eb8bee4be177b1d85ded5",
      header: "t=1777777777,v1=c26d1741d8b72c6da2c6c1661f32ba08cf3b29bc328eb8bee4be177b1d85ded5",
    });
  });

  it("verifies matching inbound or outbound payload signatures", () => {
    const payload = Buffer.from('{"event":"object.created"}');
    const signed = signWebhookPayload({
      payload,
      secret: "whsec_shared",
      timestamp: 1_777_777_777,
    });

    expect(
      verifyWebhookSignature({
        payload,
        secret: "whsec_shared",
        header: signed.header,
        now: 1_777_777_800,
      }),
    ).toBe(true);
  });

  it("rejects changed payloads, wrong secrets, malformed headers, and stale timestamps", () => {
    const signed = signWebhookPayload({
      payload: "stable",
      secret: "whsec_shared",
      timestamp: 1_777_777_777,
    });

    expect(
      verifyWebhookSignature({
        payload: "changed",
        secret: "whsec_shared",
        header: signed.header,
        now: 1_777_777_800,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        payload: "stable",
        secret: "wrong",
        header: signed.header,
        now: 1_777_777_800,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        payload: "stable",
        secret: "whsec_shared",
        header: "not-a-signature",
        now: 1_777_777_800,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        payload: "stable",
        secret: "whsec_shared",
        header: signed.header,
        now: 1_777_778_500,
      }),
    ).toBe(false);
  });

  it("parses signature headers independently for route adapters", () => {
    expect(parseWebhookSignatureHeader("t=1777777777,v1=c26d1741d8b72c6da2c6c1661f32ba08cf3b29bc328eb8bee4be177b1d85ded5")).toEqual({
      timestamp: 1_777_777_777,
      signature: "c26d1741d8b72c6da2c6c1661f32ba08cf3b29bc328eb8bee4be177b1d85ded5",
    });
  });
});
