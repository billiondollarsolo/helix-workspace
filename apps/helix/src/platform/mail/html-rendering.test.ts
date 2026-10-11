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

  it("keeps compose text formatting in inline styles and drops everything else", () => {
    const { html } = sanitizeMailHtml(`
      <div style="text-align: center">Centered</div>
      <span style="font-size: x-large; color: rgb(217, 48, 37); font-weight: bold">Big red</span>
      <span style="background-color:#FFEE00;font-style:italic;text-decoration-line:underline">Mark</span>
      <blockquote style="margin-left: 40px; padding-left: 1.5em; border: none">Indented</blockquote>
      <p style="position: fixed; top: 0; font-size: 14px; display: none">Pinned</p>
    `);
    expect(html).toContain('<div style="text-align: center">Centered</div>');
    expect(html).toContain(
      '<span style="font-size: x-large; color: rgb(217, 48, 37); font-weight: bold">Big red</span>',
    );
    expect(html).toContain(
      '<span style="background-color: #ffee00; font-style: italic; text-decoration-line: underline">',
    );
    expect(html).toContain(
      '<blockquote style="margin-left: 40px; padding-left: 1.5em">Indented</blockquote>',
    );
    expect(html).toContain('<p style="font-size: 14px">Pinned</p>');
    expect(html).not.toMatch(/position|display|border|top:/iu);
  });

  it("rejects CSS injection through inline styles", () => {
    const { html, remoteContentBlocked } = sanitizeMailHtml(`
      <p style="background-color: url(https://evil.example/track)">a</p>
      <p style="color: expression(alert(1))">b</p>
      <p style="color: var(--x)">c</p>
      <p style="color: red; background-color: u\\72l(https://evil.example/x)">d</p>
      <p style="color: re&#x64;; font-size: 12px">e</p>
      <p style="color: red/**/; font-size: 12px">f</p>
      <p style="font-size: -5px; margin-left: -9999px; padding-left: calc(100% + 1px)">g</p>
      <p style='color: red" onmouseover="alert(1)'>h</p>
      <p style="color: red !important; text-align: center; behavior: url(x.htc)">i</p>
      <p style="color: rgb(0, 0, 0) url(x)">j</p>
      <p style="font-weight: bold;}; body{background:red">k</p>
    `);
    expect(remoteContentBlocked).toBe(true);
    expect(html).not.toMatch(/url|expression|var\(|evil|calc|onmouseover|!important|behavior/iu);
    expect(html).not.toMatch(/-\d|\{|\}/u);
    expect(html).toContain("<p>a</p>");
    expect(html).toContain("<p>b</p>");
    expect(html).toContain("<p>d</p>");
    expect(html).toContain("<p>e</p>");
    expect(html).toContain("<p>f</p>");
    expect(html).toContain("<p>g</p>");
    expect(html).toContain("<p>h</p>");
    expect(html).toContain('<p style="text-align: center">i</p>');
    expect(html).toContain("<p>j</p>");
    expect(html).toContain('<p style="font-weight: bold">k</p>');
  });
});
