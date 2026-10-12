import { connect } from "node:tls";
import { summarizeCertificate, type EdgeCertificateSummary } from "./certificate.js";

/**
 * Reads the certificate the edge serves for `servername` right now, whatever
 * issued it. The certificate is reported, not trusted: the caller compares
 * fingerprints and shows expiry, so verification is deliberately off.
 */
export function probeServedCertificate(input: {
  readonly host: string;
  readonly port: number;
  readonly servername: string;
  readonly timeoutMs?: number;
}): Promise<EdgeCertificateSummary | null> {
  return new Promise((resolve) => {
    const socket = connect({
      host: input.host,
      port: input.port,
      servername: input.servername,
      rejectUnauthorized: false,
      timeout: input.timeoutMs ?? 5_000,
    });
    const finish = (result: EdgeCertificateSummary | null) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => {
      // Whatever the edge presents, describing it must never take Helix down.
      try {
        const certificate = socket.getPeerX509Certificate();
        finish(certificate === undefined ? null : summarizeCertificate(certificate));
      } catch {
        finish(null);
      }
    });
    socket.once("timeout", () => {
      finish(null);
    });
    socket.once("error", () => {
      finish(null);
    });
  });
}
