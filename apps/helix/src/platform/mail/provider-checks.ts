import { z } from "zod";
import { outboundFetch } from "../outbound-http.js";
import {
  createSmtpTransport,
  parseOutboundProviderPublicConfig,
  type OutboundProviderConfig,
} from "./providers.js";

/** Checks authentication only: never sends mail or claims recipient delivery. */
export async function checkMailProvider(
  provider: OutboundProviderConfig,
  credential: string | undefined,
): Promise<void> {
  const config = parseOutboundProviderPublicConfig(provider.kind, provider.config);
  if (provider.kind === "smtp" || provider.kind === "ses") {
    if (typeof config.user === "string" && !credential)
      throw new Error("Sending credential is missing.");
    const transport = createSmtpTransport({
      host: z.string().parse(config.host),
      ...(typeof config.port === "number" ? { port: config.port } : {}),
      ...(typeof config.secure === "boolean" ? { secure: config.secure } : {}),
      ...(typeof config.user === "string" ? { user: config.user } : {}),
      ...(credential === undefined ? {} : { pass: credential }),
    });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
    return;
  }
  if (!credential) throw new Error("Sending credential is missing.");
  const base = z
    .string()
    .parse(
      config.baseUrl ??
        (provider.kind === "mailgun" ? "https://api.mailgun.net" : "https://api.postmarkapp.com"),
    )
    .replace(/\/+$/u, "");
  const response = await outboundFetch(
    provider.kind === "mailgun"
      ? `${base}/v3/domains/${encodeURIComponent(z.string().parse(config.domain))}`
      : `${base}/server`,
    {
      method: "GET",
      headers:
        provider.kind === "mailgun"
          ? { authorization: `Basic ${Buffer.from(`api:${credential}`).toString("base64")}` }
          : { "X-Postmark-Server-Token": credential },
    },
  );
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Provider authentication check failed (${String(response.status)}).`);
}
