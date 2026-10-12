import type { AICapability } from "@helix/sdk-types";
import { UnprocessableError } from "../../api/api-error.js";
import { AIProviderRequestError } from "../ai/providers/shared.js";
import { AIProviderUnavailableError } from "../ai/routing.js";
import { OutboundHttpError } from "../outbound-http.js";

export const ASSISTANT_PROVIDER_UNREACHABLE_MESSAGE =
  "Helix AI couldn't reach its AI provider. Try again in a moment; if it keeps happening, ask your administrator to check the Helix AI provider settings.";
const ASSISTANT_PROVIDER_MISSING_MESSAGE =
  "Helix AI has no available AI provider. Ask your administrator to set up Helix AI.";

/**
 * A provider that refuses the connection, times out, is blocked by outbound
 * policy, or answers with a server error would otherwise reach the person as
 * the registry's generic "Tool invocation failed."; say what happened and who
 * can fix it. Credential and request errors already carry their own message,
 * and a cancelled turn keeps its abort.
 */
export function assistantProviderError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted === true) return error;
  if (error instanceof AIProviderUnavailableError) {
    return new UnprocessableError(ASSISTANT_PROVIDER_MISSING_MESSAGE, { cause: error });
  }
  if (
    error instanceof OutboundHttpError ||
    (error instanceof AIProviderRequestError && error.statusCode >= 500)
  ) {
    return new UnprocessableError(ASSISTANT_PROVIDER_UNREACHABLE_MESSAGE, { cause: error });
  }
  return error;
}

/** The Assistant's AI client, with provider failures turned into actionable errors. */
export function withAssistantProviderErrors(ai: AICapability): AICapability {
  const stream = ai.chatStream?.bind(ai);
  return {
    chat: async (request, ctx) => {
      try {
        return await ai.chat(request, ctx);
      } catch (error) {
        throw assistantProviderError(error, request.signal);
      }
    },
    ...(stream === undefined
      ? {}
      : {
          async *chatStream(request, ctx) {
            try {
              yield* stream(request, ctx);
            } catch (error) {
              throw assistantProviderError(error, request.signal);
            }
          },
        }),
  };
}
