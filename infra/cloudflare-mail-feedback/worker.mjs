/** Queue-only consumer: one sending domain/provider and independent secret per deployment. */
export default {
  async queue(batch, env) {
    const endpoint = new URL(env.HELIX_FEEDBACK_URL);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      !/^\/(?:v1\/)?webhooks\/mail\/providers\/[a-f0-9-]+\/[a-f0-9-]+$/u.test(endpoint.pathname)
    )
      throw new Error("Configure a credential-free HTTPS provider feedback URL.");
    if (
      !env.HELIX_FEEDBACK_SECRET ||
      env.HELIX_FEEDBACK_SECRET.length < 32 ||
      !env.CLOUDFLARE_SENDING_DOMAIN
    )
      throw new Error("Configure the dedicated feedback secret and sending domain.");
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.HELIX_FEEDBACK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    for (const message of batch.messages) {
      const event = message.body;
      if (
        event?.source?.type !== "email.sending" ||
        event.source.domain !== env.CLOUDFLARE_SENDING_DOMAIN
      )
        throw new Error("Queue event belongs to a different sending domain.");
      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)),
      );
      const digest = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-helix-signature": `t=${timestamp},v1=${digest}`,
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Workspace feedback returned ${response.status}; retrying queue message.`);
      message.ack();
    }
  },
};
