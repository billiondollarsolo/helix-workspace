import { createHash } from "node:crypto";

const TEXT_EXTENSIONS =
  /\.(?:txt|md|csv|tsv|json|log|yaml|yml|js|ts|tsx|jsx|py|sql|rs|go|java|c|cpp|h|css|html|xml|sh|toml|ini)$/iu;
export const SEARCH_FILE_BYTES = 512 * 1024;

export function isTextFile(mimeType: string, name: string): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/javascript",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ].includes(mime) ||
    (mime === "application/octet-stream" && TEXT_EXTENSIONS.test(name))
  );
}

/** No converters: index scan-clean UTF-8 bytes, with a hard cap and content-integrity check. */
export async function readSearchText(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  sha256: string,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  let size = 0,
    text = "";
  for await (const bytes of body instanceof Uint8Array ? [body] : body) {
    size += bytes.byteLength;
    if (size > SEARCH_FILE_BYTES) throw new Error("Search text exceeds the 512 KiB file limit.");
    hash.update(bytes);
    text += decoder.decode(bytes, { stream: true });
  }
  text += decoder.decode();
  if (hash.digest("hex") !== sha256)
    throw new Error("Search content differs from the scanned file.");
  if (text.includes("\0")) throw new Error("Search content contains binary data.");
  return text;
}
