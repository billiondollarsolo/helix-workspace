import type { HelixConfig, JsonObject } from "@helix/sdk-types";
import {
  ensureDefaultOrgForMode,
  type DefaultOrgInput,
  type OrgRecord,
  type OrgStore,
} from "../platform/tenancy/index.js";
import { envValueFlag } from "../platform/util/env.js";

export interface DefaultOrgBootLogger {
  info(input: JsonObject, message: string): void;
}

export async function verifyDefaultOrgAtBoot(input: {
  readonly config: Pick<HelixConfig, "mode">;
  readonly orgs: Pick<OrgStore, "getOrCreateDefaultOrg">;
  readonly defaultOrg: DefaultOrgInput;
  readonly logger: DefaultOrgBootLogger;
}): Promise<OrgRecord | null> {
  const bootDefaultOrg = await ensureDefaultOrgForMode({
    config: input.config,
    orgs: input.orgs,
    defaultOrg: input.defaultOrg,
  });
  if (bootDefaultOrg !== null) {
    input.logger.info(
      {
        orgId: bootDefaultOrg.id,
        slug: bootDefaultOrg.slug,
        region: bootDefaultOrg.region,
      },
      "Verified single-tenant default org at boot",
    );
  }
  return bootDefaultOrg;
}

export const HELIX_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.sec-websocket-protocol",
  "password",
  "secret",
  "token",
  "ticket",
];

/** @deprecated Prefer mailConfig(loadEnv(...)).receiver — kept for server.test.ts. */
export function getSmtpMailReceiverConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
):
  | {
      readonly port: number;
      readonly host?: string;
    }
  | undefined {
  if (!envValueFlag(source.MAIL_SMTP_RECEIVER_ENABLED ?? "", false)) {
    return undefined;
  }
  const host = source.MAIL_SMTP_RECEIVER_HOST;
  return {
    port: Number.parseInt(source.MAIL_SMTP_RECEIVER_PORT ?? "2525", 10),
    ...(host === undefined || host.length === 0 ? {} : { host }),
  };
}
