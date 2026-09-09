function domainOf(value) {
  const normalized = value.trim().toLowerCase().replace(/^<|>$/gu, "");
  const at = normalized.lastIndexOf("@");
  return at < 0 ? normalized : normalized.slice(at + 1);
}

function aligned(candidate, expected) {
  return (
    candidate === expected ||
    candidate.endsWith(`.${expected}`) ||
    expected.endsWith(`.${candidate}`)
  );
}

function property(value, name) {
  return (
    value.match(new RegExp(`\\b${name}\\s*=\\s*([^;\\s()]+)`, "iu"))?.[1]?.replaceAll('"', "") ??
    null
  );
}

/** Evaluate the receiving mailbox's Authentication-Results, not sender-supplied claims. */
export function evaluateAuthenticationResults(headers, expectedFromDomain) {
  const topmost =
    headers.match(/^authentication-results:\s*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/imu)?.[1] ?? "";
  const unfolded = topmost.replace(/\r?\n[ \t]+/gu, " ").toLowerCase();
  const expected = domainOf(expectedFromDomain);
  const from = domainOf(property(unfolded, "header\\.from") ?? "");
  const dkimDomain = domainOf(property(unfolded, "header\\.d") ?? "");
  const spfDomain = domainOf(property(unfolded, "smtp\\.mailfrom") ?? "");
  const dmarcPass = /\bdmarc\s*=\s*pass\b/iu.test(unfolded) && from === expected;
  const dkimAligned = /\bdkim\s*=\s*pass\b/iu.test(unfolded) && aligned(dkimDomain, expected);
  const spfAligned = /\bspf\s*=\s*pass\b/iu.test(unfolded) && aligned(spfDomain, expected);
  return {
    status: dmarcPass && (dkimAligned || spfAligned) ? "passed" : "failed",
    expectedFromDomain: expected,
    observedFromDomain: from || null,
    dkimDomain: dkimDomain || null,
    spfDomain: spfDomain || null,
    dmarcPass,
    dkimAligned,
    spfAligned,
  };
}

export function isProviderAcceptedStatus(status) {
  return ["accepted", "delivered", "deferred", "bounced", "complained"].includes(status);
}
