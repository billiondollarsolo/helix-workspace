import { useEffect, useMemo, useRef, useState } from "react";

const MESSAGE_TYPE = "helix-mail-renderer";
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1_200;

interface MailHtmlBodyProps {
  readonly html: string;
  readonly source: string;
  readonly plainBody?: string | undefined;
  readonly remoteContentBlocked: boolean;
}

export function MailHtmlBody({ html, source, plainBody, remoteContentBlocked }: MailHtmlBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<"html" | "plain" | "source">("html");
  const [height, setHeight] = useState(240);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const channel = useMemo(() => crypto.randomUUID(), []);
  const documentHtml = useMemo(() => buildMailHtmlDocument(html, channel), [channel, html]);
  const plain = useMemo(() => plainBody ?? textFromMailHtml(html), [html, plainBody]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        !isRendererMessage(event.data, channel)
      ) {
        return;
      }
      if (event.data.kind === "height") {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, event.data.value)));
        return;
      }
      const link = safeExternalLink(event.data.value);
      if (link !== null) {
        setPendingLink(link);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
    };
  }, [channel]);

  return (
    <div>
      <div
        role="group"
        aria-label="Message body view"
        style={{ display: "flex", gap: 4, marginBottom: 8 }}
      >
        {(["html", "plain", "source"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={view === mode ? "btn sm primary" : "btn sm"}
            aria-pressed={view === mode}
            onClick={() => {
              setView(mode);
            }}
          >
            {mode === "html" ? "Message" : mode === "plain" ? "Plain text" : "Source"}
          </button>
        ))}
      </div>
      {remoteContentBlocked && view === "html" && (
        <p role="note" style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          External images are blocked to prevent sender tracking.
        </p>
      )}
      {view === "html" ? (
        <iframe
          ref={iframeRef}
          title="HTML email content"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={documentHtml}
          style={{ width: "100%", height, border: 0, background: "white" }}
        />
      ) : (
        <pre
          aria-label={view === "plain" ? "Plain-text email" : "Email HTML source"}
          style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}
        >
          {view === "plain" ? plain : source}
        </pre>
      )}
      {pendingLink !== null && (
        <div role="alert" style={{ marginTop: 8, fontSize: "var(--text-caption)" }}>
          This link opens outside Helix. Verify the sender before continuing: {pendingLink}
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <a
              href={pendingLink}
              target="_blank"
              rel="noopener noreferrer"
              className="btn sm"
              onClick={() => {
                setPendingLink(null);
              }}
            >
              Open link
            </a>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setPendingLink(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function buildMailHtmlDocument(html: string, channel: string): string {
  const nonce = crypto.randomUUID();
  const css = `:root{color-scheme:light}body{margin:0;color:#202124;background:#fff;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img{display:none}table{max-width:100%;border-collapse:collapse}td,th{padding:.25rem;text-align:left}pre{white-space:pre-wrap}a{color:#1558d6;text-decoration:underline;cursor:pointer}summary{cursor:pointer;color:#5f6368;margin:.5rem 0}`;
  const script = `const channel=${JSON.stringify(channel)};const send=(kind,value)=>parent.postMessage({type:${JSON.stringify(MESSAGE_TYPE)},channel,kind,value},'*');for(const quote of document.querySelectorAll('blockquote,.gmail_quote')){if(quote.closest('details[data-helix-quote]'))continue;const details=document.createElement('details');details.dataset.helixQuote='';const summary=document.createElement('summary');summary.textContent='Show quoted text';quote.before(details);details.append(summary,quote)}const resize=()=>send('height',document.documentElement.scrollHeight);document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[data-helix-href]'):null;if(!link)return;event.preventDefault();send('link',link.getAttribute('data-helix-href'))});document.addEventListener('toggle',resize,true);resize();`;
  const csp = `default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style nonce="${nonce}">${css}</style></head><body>${html}<script nonce="${nonce}">${script}</script></body></html>`;
}

function textFromMailHtml(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";
}

function safeExternalLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function isRendererMessage(
  value: unknown,
  channel: string,
): value is
  | {
      readonly type: typeof MESSAGE_TYPE;
      readonly channel: string;
      readonly kind: "height";
      readonly value: number;
    }
  | {
      readonly type: typeof MESSAGE_TYPE;
      readonly channel: string;
      readonly kind: "link";
      readonly value: string;
    } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.type === MESSAGE_TYPE &&
    message.channel === channel &&
    ((message.kind === "height" &&
      typeof message.value === "number" &&
      Number.isFinite(message.value)) ||
      (message.kind === "link" && typeof message.value === "string"))
  );
}
