import type { DataClassification } from "@helix/sdk-types";
import { Parser } from "htmlparser2";
import { z } from "zod";
import { BadRequestError } from "../../api/api-error.js";
import {
  dataClassifications,
  deriveClassification,
  maxClassification,
} from "../ai/classification/index.js";
import { detectDlp } from "../dlp.js";
import {
  createOutboundHttpClient,
  OutboundHttpError,
  type OutboundHttpClientOptions,
} from "../outbound-http.js";

export const webFetchInputSchema = z
  .object({
    url: z.string().trim().url().max(2_048),
    offset: z.number().int().min(0).max(1_048_576).default(0),
    limit: z.number().int().min(1).max(4_000).default(2_000),
  })
  .strict();
export const webFetchResultSchema = z
  .object({
    url: z.string().url().max(2_048),
    title: z.string().max(200),
    contentType: z.enum(["text/html", "text/plain", "application/xhtml+xml"]),
    content: z.string().max(4_000),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    totalChars: z.number().int().nonnegative(),
    truncated: z.boolean(),
    classification: z.enum(dataClassifications),
  })
  .strict();
export type WebFetchResult = z.infer<typeof webFetchResultSchema>;

/** Read one bounded public HTTPS page. It never runs scripts or loads subresources. */
export async function fetchWebPage(
  input: z.input<typeof webFetchInputSchema>,
  options: Pick<OutboundHttpClientOptions, "resolve" | "transport"> & {
    readonly signal?: AbortSignal;
  } = {},
): Promise<WebFetchResult> {
  const parsed = webFetchInputSchema.safeParse(input);
  if (!parsed.success)
    throw new BadRequestError(
      "Enter a valid public HTTPS URL and a valid page offset/limit (up to 4,000 characters).",
    );
  const { url, offset, limit } = parsed.data;
  const send = createOutboundHttpClient({
    ...options,
    production: true,
    allowHttp: false,
    allowPrivateNetwork: false,
    timeoutMs: 10_000,
    maxResponseBytes: 1_048_576,
    maxRedirects: 3,
    validateUrl: assertPublicPageUrl,
  });
  try {
    const response = await send(url, {
      headers: {
        accept: "text/html, text/plain, application/xhtml+xml",
        "user-agent": "Helix-Web/1.0",
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BadRequestError(
        `Public page returned HTTP ${String(response.status)}. It may require sign-in or block automated reading.`,
      );
    }
    const contentType = webFetchResultSchema.shape.contentType.safeParse(
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
    );
    if (
      !contentType.success ||
      /^attachment(?:;|$)/iu.test(response.headers.get("content-disposition") ?? "")
    ) {
      await response.body?.cancel();
      throw new BadRequestError(
        "Only public HTML and plain-text pages can be read. PDFs, downloads, and other formats are unsupported.",
      );
    }
    const source = await response.text();
    const page =
      contentType.data === "text/plain" ? { title: "", text: source } : htmlPageText(source);
    if (!page.text.trim())
      throw new BadRequestError(
        "This page has no readable static text. Pages requiring JavaScript or sign-in are unsupported.",
      );
    const classification = classifyPageText(`${response.url}\n${page.title}\n${page.text}`);
    if (offset > page.text.length)
      throw new BadRequestError(
        "Page offset exceeds its current text length. Fetch again from offset 0.",
      );
    if (
      offset > 0 &&
      /[\uDC00-\uDFFF]/u.test(page.text.charAt(offset)) &&
      /[\uD800-\uDBFF]/u.test(page.text.charAt(offset - 1))
    )
      throw new BadRequestError(
        "Use the returned nextOffset to continue without splitting a character.",
      );
    let endOffset = Math.min(page.text.length, offset + limit);
    if (endOffset < page.text.length && /[\uD800-\uDBFF]/u.test(page.text.charAt(endOffset - 1)))
      endOffset -= 1;
    if (endOffset === offset && endOffset < page.text.length)
      throw new BadRequestError("Increase the page limit to include a complete character.");
    const content = page.text.slice(offset, endOffset);
    const end = offset + content.length;
    return {
      url: response.url,
      title: page.title,
      contentType: contentType.data,
      content,
      offset,
      nextOffset: end < page.text.length ? end : null,
      totalChars: page.text.length,
      truncated: offset > 0 || end < page.text.length,
      classification,
    };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    if (error instanceof OutboundHttpError)
      throw new BadRequestError(
        error.code === "response_too_large"
          ? "Page exceeds the 1 MiB reading limit."
          : error.code === "blocked_destination"
            ? "Page destination is blocked. Use a public HTTPS page; private networks and unsafe redirects are not allowed."
            : error.code === "aborted"
              ? "Page reading was cancelled or exceeded the 10-second timeout."
              : "Could not read the public page. Check its address and try again.",
      );
    throw new BadRequestError("Could not read the public page. Check its address and try again.");
  }
}

function assertPublicPageUrl(url: URL): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.href);
  } catch {
    throw new BadRequestError("Page URL contains invalid encoding.");
  }
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(?:access[_-]?token|api[_-]?key|authorization|auth|password|secret|token|signature|x-amz-.+)$/iu.test(
        key,
      ),
    ) ||
    url.href.length > 2_048 ||
    ["confidential", "restricted"].includes(classifyPageText(decoded))
  )
    throw new BadRequestError("Page URL cannot contain credentials or sensitive workspace data.");
}

function classifyPageText(text: string): DataClassification {
  const normalized = text.normalize("NFKC");
  return detectDlp(normalized, new Set(["credentials", "pii", "credit_card"])).reduce(
    (classification, finding) => maxClassification(classification, finding.classification),
    deriveClassification({ content: normalized, scanContent: true }).classification,
  );
}

const skippedTags = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
]);
const blockTags = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "tr",
  "td",
  "th",
  "pre",
  "blockquote",
]);
function htmlPageText(html: string): { title: string; text: string } {
  const hidden: boolean[] = [],
    parts: string[] = [],
    title: string[] = [];
  let titleDepth = 0;
  let inHead = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        hidden.push(
          hidden.at(-1) === true ||
            skippedTags.has(name) ||
            attributes.hidden !== undefined ||
            attributes["aria-hidden"] === "true",
        );
        if (name === "head") inHead = true;
        if (name === "title" && inHead) titleDepth += 1;
        if (!hidden.at(-1) && blockTags.has(name)) parts.push("\n");
      },
      ontext(text) {
        if (titleDepth > 0) title.push(text);
        else if (!hidden.at(-1)) parts.push(text);
      },
      onclosetag(name) {
        if (name === "head") inHead = false;
        if (name === "title") titleDepth = Math.max(0, titleDepth - 1);
        const wasHidden = hidden.pop();
        if (!wasHidden && blockTags.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return {
    title: title.join("").replace(/\s+/gu, " ").trim().slice(0, 200),
    text: parts
      .join("")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/\n\s*\n/gu, "\n\n")
      .trim(),
  };
}
