export function parseBasicAuthorization(
  authorization: string | undefined,
): { readonly username: string; readonly password: string } | null {
  if (authorization === undefined) {
    return null;
  }
  const [scheme, value] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "basic" || value === undefined) {
    return null;
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
