export const SANDBOXED_CONTENT_CSP = [
  "sandbox",
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ");

const ACTIVE_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/vnd.mozilla.xul+xml",
  "application/wasm",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "message/rfc822",
  "multipart/related",
  "text/css",
  "text/ecmascript",
  "text/html",
  "text/javascript",
  "text/xml",
]);

const ACTIVE_FILE_EXTENSION =
  /\.(?:css|html?|js|mjs|cjs|mht|mhtml|shtml|svgz?|wasm|xht|xhtml|xml|xsl|xslt|xul)$/iu;

/** Active bytes are never served with a browser-executable type or inline disposition. */
export function safeDriveContentHeaders(
  filename: string,
  mimeType: string,
  inlineRequested: boolean,
): { readonly disposition: string; readonly mimeType: string } {
  const active = isActiveBrowserContent(filename, mimeType);
  const attachment = !inlineRequested || active;
  const asciiFilename = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const encodedFilename = encodeURIComponent(filename);
  return {
    disposition: `${attachment ? "attachment" : "inline"}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
    mimeType: active ? "application/octet-stream" : mimeType || "application/octet-stream",
  };
}

export function isActiveBrowserContent(filename: string, mimeType: string): boolean {
  const normalizedMime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    ACTIVE_MIME_TYPES.has(normalizedMime) ||
    normalizedMime.endsWith("+xml") ||
    ACTIVE_FILE_EXTENSION.test(filename)
  );
}

/**
 * Converted document fragments retain inert formatting only. Links, styles,
 * forms, scripts, embeds, media and every network-bearing attribute are gone
 * before the browser receives the response.
 */
