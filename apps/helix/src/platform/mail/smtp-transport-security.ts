import type { SecureVersion } from "node:tls";
import { isIP } from "node:net";
import type { SMTPServerOptions, SMTPServerSession } from "smtp-server";

export type SmtpTransportSecurity =
  | {
      /** Public SMTP listener offering STARTTLS with operator-provided material. */
      readonly mode: "starttls";
      readonly key: string | Buffer;
      readonly cert: string | Buffer;
      readonly ca?: string | Buffer | (string | Buffer)[] | undefined;
      readonly minVersion?: SecureVersion | undefined;
      /** Restrict a private Postfix handoff that forwards the original SMTP client. */
      readonly trustedForwarderIps?: readonly string[] | undefined;
    }
  | {
      /** Private listener behind an attested TLS-terminating SMTP proxy. */
      readonly mode: "trusted-proxy";
      readonly proxyProtocol: boolean;
      readonly trustedProxyIps: readonly string[];
    }
  | {
      /** Local test/development only; production assertions must reject it. */
      readonly mode: "development-plaintext";
    };

export function smtpTransportSecurityOptions(
  security: SmtpTransportSecurity,
): Pick<
  SMTPServerOptions,
  | "secure"
  | "secured"
  | "hideSTARTTLS"
  | "useProxy"
  | "useXForward"
  | "key"
  | "cert"
  | "ca"
  | "minVersion"
> {
  switch (security.mode) {
    case "starttls":
      if (
        security.trustedForwarderIps !== undefined &&
        (security.trustedForwarderIps.length === 0 ||
          security.trustedForwarderIps.some((ip) => isIP(ip) === 0))
      ) {
        throw new Error("SMTP client forwarding requires an explicit forwarder IP allowlist.");
      }
      assertTlsMaterial(security.key, "key");
      assertTlsMaterial(security.cert, "certificate");
      return {
        secure: false,
        secured: false,
        hideSTARTTLS: false,
        useXForward: security.trustedForwarderIps !== undefined,
        key: security.key,
        cert: security.cert,
        ...(security.ca === undefined ? {} : { ca: security.ca }),
        minVersion: security.minVersion ?? "TLSv1.2",
      };
    case "trusted-proxy":
      if (
        security.trustedProxyIps.length === 0 ||
        security.trustedProxyIps.some((address) => address === "*")
      ) {
        throw new Error("Trusted SMTP proxy mode requires an explicit proxy IP allowlist.");
      }
      return {
        secure: false,
        secured: true,
        hideSTARTTLS: true,
        // smtp-server accepts an address array at runtime even though its
        // published TypeScript declaration still narrows this option to boolean.
        // @ts-expect-error smtp-server supports explicit proxy IP arrays; its declaration only allows boolean.
        useProxy: [...security.trustedProxyIps],
      };
    case "development-plaintext":
      return {
        secure: false,
        secured: false,
        hideSTARTTLS: true,
        useProxy: false,
      };
  }
}

export function smtpDisabledCommands(
  security: SmtpTransportSecurity,
  configured: readonly string[] = ["AUTH"],
): string[] {
  const commands = new Set(configured.map((command) => command.toUpperCase()));
  commands.add("AUTH");
  if (security.mode === "starttls") {
    commands.delete("STARTTLS");
  } else {
    commands.add("STARTTLS");
  }
  return [...commands];
}

export function takeSmtpClientIdentity(
  session: SMTPServerSession,
  security: SmtpTransportSecurity,
  connectionAddress: string,
) {
  // XFORWARD changes the connection first; session fields refresh only on RSET.
  const forwardedHandoff =
    security.mode === "starttls" && security.trustedForwarderIps !== undefined;
  const forwarded: unknown =
    forwardedHandoff && "xForward" in session ? session.xForward : undefined;
  const address: unknown = forwarded instanceof Map ? forwarded.get("ADDR") : undefined;
  const helo: unknown = forwarded instanceof Map ? forwarded.get("HELO") : undefined;
  // Each message on a pooled edge connection needs a fresh forwarded identity.
  if (forwarded instanceof Map) forwarded.clear();
  return {
    remoteAddress: typeof address === "string" && isIP(address) !== 0 ? address : connectionAddress,
    helo:
      typeof helo === "string" && helo !== "[UNAVAILABLE]"
        ? helo
        : forwardedHandoff
          ? undefined
          : session.hostNameAppearsAs,
  };
}

function assertTlsMaterial(value: string | Buffer, label: string): void {
  if ((typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength) === 0) {
    throw new Error(`SMTP TLS ${label} must not be empty.`);
  }
}

export function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

export function asSmtpError(error: unknown, fallbackCode: number, fallbackMessage: string): Error {
  if (
    error instanceof Error &&
    "responseCode" in error &&
    typeof (error as { readonly responseCode?: unknown }).responseCode === "number"
  ) {
    return error;
  }
  return smtpError(fallbackCode, fallbackMessage);
}
