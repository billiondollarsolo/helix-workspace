import { z } from "zod";
import { optionalString, optionalUrl } from "./common.js";
export const aiEnv = {
  HELIX_AI_ALLOW_PRIVATE_NETWORK: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalUrl,
  OPENAI_MODEL: optionalString,
  OLLAMA_BASE_URL: optionalUrl,
  OLLAMA_MODEL: optionalString,
  AI_DEFAULT_PROVIDER_ID: optionalString,
  ASSISTANT_AI_PROVIDER_ID: optionalString,
};
