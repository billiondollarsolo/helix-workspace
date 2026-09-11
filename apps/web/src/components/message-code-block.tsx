import { useState, type ReactNode } from "react";
import "./message-code-block.css";

export function MessageCodeBlock({
  code,
  language,
}: {
  readonly code: string;
  readonly language: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  return (
    <section className="message-code-block">
      <header>
        <span>{language}</span>
        <button
          type="button"
          aria-label={`Copy ${language} code`}
          onClick={() => {
            setCopyError(false);
            void (
              navigator.clipboard?.writeText(code) ??
              Promise.reject(new Error("Clipboard unavailable"))
            )
              .then(() => {
                setCopied(code);
              })
              .catch(() => {
                setCopyError(true);
              });
          }}
        >
          {copied === code ? "Copied" : "Copy"}
        </button>
      </header>
      {copyError ? <p role="alert">Could not copy. Select the code and copy it manually.</p> : null}
      <pre tabIndex={0} aria-label={`${language} code`}>
        <code>{highlightCode(code, language)}</code>
      </pre>
    </section>
  );
}

function highlightCode(code: string, language: string): readonly ReactNode[] {
  if (
    !/^(?:js|jsx|ts|tsx|javascript|typescript|json|css|html|sql|bash|sh|python|py)$/u.test(language)
  ) {
    return [code];
  }
  const token =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|true|false|null|select|from|where|insert|update|delete|create|alter|table)\b|\b\d+(?:\.\d+)?\b)/giu;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of code.matchAll(token)) {
    const start = match.index;
    if (start > cursor) nodes.push(code.slice(cursor, start));
    const value = match[0];
    const className =
      value.startsWith("//") || value.startsWith("/*")
        ? "comment"
        : /^['"]/u.test(value)
          ? "string"
          : /^\d/u.test(value)
            ? "number"
            : "keyword";
    nodes.push(
      <span key={`${String(start)}:${value}`} className={`message-code-${className}`}>
        {value}
      </span>,
    );
    cursor = start + value.length;
  }
  if (cursor < code.length) nodes.push(code.slice(cursor));
  return nodes;
}
