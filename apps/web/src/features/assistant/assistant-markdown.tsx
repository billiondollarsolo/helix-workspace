import { memo } from "react";
import remarkGfm from "remark-gfm";
import Markdown, { type Components } from "react-markdown";
import { MessageCodeBlock } from "@/components/message-code-block";
import "./assistant-markdown.css";

const components: Components = {
  table: ({ children }) => (
    <div className="overflow-x-auto" role="region" aria-label="Response table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  // Raw HTML and remote images from model output must never execute or make requests.
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  pre: ({ node }) => {
    const code = node?.children.find(
      (child) => child.type === "element" && child.tagName === "code",
    );
    if (code?.type !== "element") return null;
    const language = String(code.properties.className ?? "").replace(/^language-/u, "") || "code";
    const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
    return <MessageCodeBlock code={text.replace(/\n$/u, "")} language={language} />;
  },
};

function safeLink(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
      ? value
      : "";
  } catch {
    return "";
  }
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
}: {
  readonly text: string;
}) {
  return (
    <div className="assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeLink}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
