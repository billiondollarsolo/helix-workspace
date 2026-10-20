import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "./worker.mjs";
test("queue bridge signs exact bytes, acknowledges only accepted events, and rejects another domain", async () => {
  const original = globalThis.fetch;
  const env = {
    HELIX_FEEDBACK_URL:
      "https://workspace.example.com/v1/webhooks/mail/providers/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
    HELIX_FEEDBACK_SECRET: "test-only-independent-feedback-key",
    CLOUDFLARE_SENDING_DOMAIN: "example.com",
  };
  let acked = 0;
  const message = {
    body: {
      source: { type: "email.sending", domain: "example.com" },
      type: "cf.email.sending.message.delivered",
    },
    ack: () => {
      acked++;
    },
  };
  try {
    globalThis.fetch = async (_url, options) => {
      const match = /^t=(\d+),v1=([a-f0-9]+)$/u.exec(options.headers["x-helix-signature"]);
      assert.ok(match);
      assert.equal(
        match[2],
        createHmac("sha256", env.HELIX_FEEDBACK_SECRET)
          .update(`${match[1]}.${options.body}`)
          .digest("hex"),
      );
      return new Response(null, { status: 202 });
    };
    await worker.queue({ messages: [message] }, env);
    assert.equal(acked, 1);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(worker.queue({ messages: [message] }, env), /retrying/u);
    assert.equal(acked, 1);
    await assert.rejects(
      worker.queue(
        {
          messages: [
            { ...message, body: { source: { type: "email.sending", domain: "other.example" } } },
          ],
        },
        env,
      ),
      /different sending domain/u,
    );
  } finally {
    globalThis.fetch = original;
  }
});
