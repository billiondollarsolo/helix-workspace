import { z } from "zod";
import { BadRequestError } from "../../api/api-error.js";
import {
  createOutboundHttpClient,
  OutboundHttpError,
  type OutboundHttpClientOptions,
} from "../outbound-http.js";
import type { OpenedAgentSecret } from "./store.js";

const MAX_BODY_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 1_048_576;
/** What takes the value's place wherever a response repeats it. */
export const SECRET_PLACEHOLDER = "[secret]";

/** Headers the connection owns; an agent may not set them. */
const reservedHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const secretHttpRequestSchema = z
  .object({
    secret: z.string().min(1).max(63),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.string().trim().url().max(2_048),
    headers: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/u),
        z
          .string()
          .max(4_096)
          .regex(/^[^\r\n\0]*$/u),
      )
      .default({}),
    body: z.string().max(MAX_BODY_BYTES).optional(),
  })
  .strict();

export const secretHttpResponseSchema = z.object({
  status: z.number().int(),
  contentType: z.string().nullable(),
  body: z.string(),
});

export type SecretHttpRequest = z.output<typeof secretHttpRequestSchema>;
export type SecretHttpResponse = z.output<typeof secretHttpResponseSchema>;

/**
 * Check a request before anything is sent or recorded: the secret can travel
 * in a header, the agent has not set a header Helix owns, and the address is
 * one the secret may be sent to. Returns the request's headers and host.
 */
export function checkSecretRequest(
  secret: OpenedAgentSecret,
  request: SecretHttpRequest,
): { readonly host: string; readonly headers: Headers } {
  if (/[\r\n\0]/u.test(secret.value)) {
    throw new BadRequestError(
      `The secret ${secret.name} has more than one line, so it cannot be sent in a request header.`,
    );
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === secret.headerName || reservedHeaders.has(lower)) {
      throw new BadRequestError(`The ${lower} header is set by Helix and cannot be supplied.`);
    }
    headers.set(lower, value);
  }
  const url = new URL(request.url);
  assertSecretDestination(secret, url);
  return { host: url.hostname, headers };
}

function assertSecretDestination(secret: OpenedAgentSecret, url: URL): void {
  if (secret.allowedHosts.length === 0) {
    throw new BadRequestError(
      `The secret ${secret.name} is not set up to be sent in requests. An administrator can add the hosts it may be sent to.`,
    );
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new BadRequestError(
      "Secrets are sent only to plain https:// addresses on the default port.",
    );
  }
  if (!secret.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new BadRequestError(
      `The secret ${secret.name} may be sent only to: ${secret.allowedHosts.join(", ")}.`,
    );
  }
}

/**
 * Make one HTTPS request for an agent with the secret added as a header. The
 * agent receives the response, with any copy of the value taken out, and
 * never the value itself.
 */
export async function sendWithSecret(
  secret: OpenedAgentSecret,
  request: SecretHttpRequest,
  options: Pick<OutboundHttpClientOptions, "resolve" | "transport"> = {},
): Promise<SecretHttpResponse> {
  const { headers } = checkSecretRequest(secret, request);
  headers.set(secret.headerName, `${secret.headerPrefix}${secret.value}`);

  const send = createOutboundHttpClient({
    ...options,
    production: true,
    allowHttp: false,
    allowPrivateNetwork: false,
    timeoutMs: 30_000,
    maxRequestBytes: MAX_BODY_BYTES,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 3,
    // Checked on every hop, so a redirect cannot carry the secret elsewhere.
    validateUrl: (url) => {
      assertSecretDestination(secret, url);
    },
  });
  try {
    const response = await send(request.url, {
      method: request.method,
      headers,
      ...(request.body === undefined || request.method === "GET" ? {} : { body: request.body }),
    });
    const body = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: body.replaceAll(secret.value, SECRET_PLACEHOLDER),
    };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    if (error instanceof OutboundHttpError) {
      throw new BadRequestError(
        error.code === "response_too_large"
          ? "The response was larger than 1 MiB."
          : error.code === "blocked_destination"
            ? "That destination is blocked. Requests go only to public HTTPS hosts."
            : error.code === "aborted"
              ? "The request was cancelled or took longer than 30 seconds."
              : "The request could not be completed. Check the address and try again.",
      );
    }
    throw new BadRequestError(
      "The request could not be completed. Check the address and try again.",
    );
  }
}
