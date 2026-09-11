import type { AiConfig, DataClassification, HelixConfig } from "@helix/sdk-types";
import { BlockList, isIP } from "node:net";
import { detectDlp } from "../../dlp.js";
import { tierDefaults } from "../../config/tier.js";
import { deriveClassification, maxClassification } from "../classification/policy.js";
import { AIClassificationBlockedError } from "../routing.js";
import type { MemoryEmbeddingProvider } from "./types.js";

/** Enforce the same external-egress floor for both memory writes and query embeddings. */
export function protectMemoryEmbeddings(
  provider: MemoryEmbeddingProvider,
  ai: AiConfig | undefined,
  security: HelixConfig["security"] = { tier: "personal" },
): MemoryEmbeddingProvider {
  const endpoint = ai?.embeddingProvider?.config?.baseUrl;
  let hostname: string;
  try {
    hostname = new URL(
      typeof endpoint === "string" ? endpoint : "https://api.openai.com/v1",
    ).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new TypeError("Memory embeddings require a valid configured endpoint.");
  }
  const local =
    hostname === "localhost" ||
    (isIP(hostname) !== 0 &&
      localAddresses.check(hostname, isIP(hostname) === 6 ? "ipv6" : "ipv4"));
  return {
    async embed(texts, classification: DataClassification = "standard") {
      const effective = texts.reduce<DataClassification>(
        (floor, content) => classifyMemoryContent(content, floor),
        classification,
      );
      if (
        !local &&
        (security.tier === "sovereign" ||
          (security.overrides?.localAiOnly ?? tierDefaults[security.tier].localAiOnly) ||
          effective === "restricted" ||
          (ai?.privacy?.blockExternalForClassifications ?? ["confidential", "restricted"]).includes(
            effective,
          ))
      )
        throw new AIClassificationBlockedError(
          "The configured memory embedding provider cannot process this data classification.",
        );
      return provider.embed(texts);
    },
  };
}

export function classifyMemoryContent(
  content: string,
  floor: DataClassification,
): DataClassification {
  return detectDlp(content, new Set(["credentials"])).length > 0
    ? "restricted"
    : maxClassification(floor, deriveClassification({ content, scanContent: true }).classification);
}

const localAddresses = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
] as const)
  localAddresses.addSubnet(network, prefix, "ipv4");
localAddresses.addSubnet("fc00::", 7, "ipv6");
localAddresses.addAddress("::1", "ipv6");
