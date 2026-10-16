import { useEffect, useMemo, useRef, useState } from "react";
import { randomId } from "@/lib/random-id";
import documentStyles from "./mail-html-document.css?inline";

const MESSAGE_TYPE = "helix-mail-renderer";
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 20_000;

interface MailHtmlBodyProps {
  readonly html: string;
  readonly remoteContentBlocked: boolean;
}

export function MailHtmlBody({ html, remoteContentBlocked }: MailHtmlBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const channel = useMemo(() => randomId(), []);
  const documentHtml = useMemo(() => buildMailHtmlDocument(html, channel), [channel, html]);

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
    <div className="mail-html-body">
      {remoteContentBlocked && (
        <p role="note" className="mail-remote-content-note">
          External images are blocked to prevent sender tracking.
        </p>
      )}
      <iframe
        ref={iframeRef}
        title="HTML email content"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={documentHtml}
        className="mail-html-frame"
        style={{ height }}
      />
      {pendingLink !== null && (
        <div role="alert" className="mt-2 type-caption">
          This link opens outside Helix. Verify the sender before continuing: {pendingLink}
          <div className="mt-1 flex gap-1">
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
  const nonce = randomId();
  const script = `const channel=decodeURIComponent(document.currentScript.dataset.channel);const send=(kind,value)=>parent.postMessage({type:${JSON.stringify(MESSAGE_TYPE)},channel,kind,value},'*');for(let quote of document.querySelectorAll('blockquote,.gmail_quote')){if(quote.closest('details[data-helix-quote]'))continue;const attribution=quote.previousElementSibling;if(quote.parentElement.children.length===2&&attribution&&/^On[\\s\\S]+wrote:\\s*$/.test(attribution.textContent))quote=quote.parentElement;const details=document.createElement('details');details.dataset.helixQuote='';const summary=document.createElement('summary');summary.textContent='…';summary.setAttribute('aria-label','Show quoted text');summary.title='Show quoted text';quote.before(details);details.append(summary,quote)}const resize=()=>send('height',Math.ceil(document.body.getBoundingClientRect().height));document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[data-helix-href]'):null;if(!link)return;event.preventDefault();send('link',link.getAttribute('data-helix-href'))});document.addEventListener('toggle',resize,true);new ResizeObserver(resize).observe(document.body);resize();`;
  const csp = `default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style nonce="${nonce}">${documentStyles}</style></head><body>${html}<script nonce="${nonce}" data-channel="${encodeURIComponent(channel)}">${script}</script></body></html>`;
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
