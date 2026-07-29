import type { NodeConnectionOptions } from "@nats-io/transport-node";

export interface ChatNatsSecurityPolicy {
  readonly connection: NodeConnectionOptions;
  readonly publishSubjects: readonly string[];
  readonly subscribeSubjects: readonly string[];
}

/**
 * Strict production seam for the NATS connection used by Chat fan-out.
 * Credentials remain server-side and subjects are constrained per tenant.
 */
export function createChatNatsSecurityPolicy(
  env: NodeJS.ProcessEnv,
  orgIds: readonly string[],
  production = env.NODE_ENV === "production",
): ChatNatsSecurityPolicy {
  const servers = splitList(env.NATS_URL);
  const user = trimmed(env.NATS_USER);
  const pass = trimmed(env.NATS_PASSWORD);
  const token = trimmed(env.NATS_TOKEN);
  const caFile = trimmed(env.NATS_TLS_CA_FILE);
  const certFile = trimmed(env.NATS_TLS_CERT_FILE);
  const keyFile = trimmed(env.NATS_TLS_KEY_FILE);

  if ((user === undefined) !== (pass === undefined)) {
    throw new Error("NATS_USER and NATS_PASSWORD must be configured together.");
  }
  if (token !== undefined && user !== undefined) {
    throw new Error("NATS_TOKEN cannot be combined with NATS user/password authentication.");
  }
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error("NATS mTLS certificate and key files must be configured together.");
  }
  if (production) {
    if (servers.length === 0) throw new Error("Production Chat requires NATS_URL.");
    if (servers.some((server) => !server.startsWith("tls://"))) {
      throw new Error("Production Chat NATS requires tls: server URLs.");
    }
    if (user === undefined && token === undefined) {
      throw new Error("Production Chat NATS requires authenticated credentials.");
    }
    if (caFile === undefined || certFile === undefined || keyFile === undefined) {
      throw new Error("Production Chat NATS requires CA-pinned mutual TLS.");
    }
  }

  const tls =
    caFile === undefined && certFile === undefined
      ? undefined
      : {
          rejectUnauthorized: true,
          ...(caFile === undefined ? {} : { caFile }),
          ...(certFile === undefined ? {} : { certFile }),
          ...(keyFile === undefined ? {} : { keyFile }),
        };
  const scopedSubjects = [...new Set(orgIds)].map(
    (orgId) => `helix.chat.org.${subjectPart(orgId)}.room.*.events`,
  );
  return {
    connection: {
      ...(servers.length === 0 ? {} : { servers }),
      name: "helix-chat",
      noEcho: true,
      reconnect: true,
      maxReconnectAttempts: -1,
      ...(user === undefined ? {} : { user, pass: pass as string }),
      ...(token === undefined ? {} : { token }),
      ...(tls === undefined ? {} : { tls }),
    },
    publishSubjects: scopedSubjects,
    subscribeSubjects: scopedSubjects,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result.length === 0 ? undefined : result;
}

function subjectPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_");
}
