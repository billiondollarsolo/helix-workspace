import type { SecureVersion } from "node:tls";
import type { SMTPServerOptions } from "smtp-server";

export type SmtpTransportSecurity =
  | {
      /** Public SMTP listener offering STARTTLS with operator-provided material. */
      readonly mode: "starttls";
      readonly key: string | Buffer;
      readonly cert: string | Buffer;
      readonly ca?: string | Buffer | (string | Buffer)[] | undefined;
      readonly minVersion?: SecureVersion | undefined;
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
  "secure" | "secured" | "hideSTARTTLS" | "useProxy" | "key" | "cert" | "ca" | "minVersion"
> {
  switch (security.mode) {
    case "starttls":
      assertTlsMaterial(security.key, "key");
      assertTlsMaterial(security.cert, "certificate");
      return {
        secure: false,
        secured: false,
        hideSTARTTLS: false,
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
        useProxy: [...security.trustedProxyIps] as unknown as boolean,
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

function assertTlsMaterial(value: string | Buffer, label: string): void {
  if ((typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength) === 0) {
    throw new Error(`SMTP TLS ${label} must not be empty.`);
  }
}
