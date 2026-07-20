import { env as loadValidatedEnv } from "../../config/env.js";

export interface InlineBodyFallbackEnv {
  readonly NODE_ENV?: string | undefined;
}

export interface InlineBodyFallback {
  readonly body: Buffer;
  readonly mime?: string | undefined;
}

function defaultInlineBodyEnv(): InlineBodyFallbackEnv {
  return { NODE_ENV: loadValidatedEnv().NODE_ENV };
}

export function readInlineBodyFallback(
  metadata: Record<string, unknown>,
  env: InlineBodyFallbackEnv = defaultInlineBodyEnv(),
): InlineBodyFallback | null {
  const inlineBody = metadata.inlineBody;
  if (typeof inlineBody !== "string" || !allowInlineBodyFallback(metadata, env)) {
    return null;
  }
  return {
    body: Buffer.from(inlineBody, "base64"),
    ...(typeof metadata.inlineMime === "string" ? { mime: metadata.inlineMime } : {}),
  };
}

export function allowInlineBodyFallback(
  metadata: Record<string, unknown>,
  env: InlineBodyFallbackEnv = defaultInlineBodyEnv(),
): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }
  const hasDevSeedMarker =
    metadata.source === "corpus" ||
    metadata.backfilled === true ||
    metadata.migratedFromNative === true ||
    metadata.inlineBodyDevFallback === true;
  return (
    hasDevSeedMarker &&
    metadata.latestVersionId === undefined &&
    metadata.versionNumber === undefined &&
    metadata.status !== "ready"
  );
}
