// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMailHtmlDocument, MailHtmlBody } from "./mail-html-body";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MailHtmlBody", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLDivElement[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => {
        root.unmount();
      });
    }
    for (const container of containers.splice(0)) {
      container.remove();
    }
    vi.restoreAllMocks();
  });

  it("builds a no-network opaque-origin document and accessibly trims quoted replies", () => {
    const documentHtml = buildMailHtmlDocument(
      '<h1>Newsletter</h1><blockquote>Older reply</blockquote><a href="#helix-link" data-helix-href="https://example.com">Open</a>',
      "test-channel",
    );
    expect(documentHtml).toContain("default-src 'none'");
    expect(documentHtml).toContain("connect-src 'none'");
    expect(documentHtml).toContain("img-src 'none'");
    expect(documentHtml).toContain("form-action 'none'");
    expect(documentHtml).toContain("Show quoted text");
    expect(documentHtml).toContain("details[data-helix-quote]");
    expect(documentHtml).toContain("test-channel");
    const script = /<script[^>]*>(.*?)<\/script>/su.exec(documentHtml)?.[1];
    expect(script).toBeDefined();
    const digest = createHash("sha256")
      .update(script ?? "")
      .digest("base64");
    for (const edge of [
      "Caddyfile.production",
      "Caddyfile",
      "examples/tier2-upstream-mtls.Caddyfile",
    ]) {
      const policy = readFileSync(`../../infra/caddy/${edge}`, "utf8");
      expect(policy).toContain(`'sha256-${digest}'`);
    }
  });

  it("keeps raw source inert and offers plain text without inserting either into the app DOM", () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const source = '<img src="https://tracker.test"><script>window.evil=1</script><b>Hello</b>';

    act(() => {
      root.render(
        <MailHtmlBody
          html="<b>Hello</b><img/>"
          source={source}
          plainBody="Hello"
          remoteContentBlocked
        />,
      );
    });

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(container.textContent).toContain("blocked to prevent sender tracking");
    expect(container.querySelector("script")).toBeNull();

    click(container, "Source");
    expect(container.querySelector('[aria-label="Email HTML source"]')?.textContent).toBe(source);
    expect(container.querySelector("script")).toBeNull();

    click(container, "Plain text");
    expect(container.querySelector('[aria-label="Plain-text email"]')?.textContent).toBe("Hello");
  });

  it("warns before a validated external link can leave the isolated renderer", () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <MailHtmlBody
          html={'<a href="#helix-link" data-helix-href="https://example.com/report">Report</a>'}
          source=""
          remoteContentBlocked={false}
        />,
      );
    });
    const iframe = container.querySelector("iframe");
    const channel = /data-channel="([^"]+)"/u.exec(iframe?.srcdoc ?? "")?.[1];
    expect(channel).toBeDefined();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe?.contentWindow,
          data: {
            type: "helix-mail-renderer",
            channel,
            kind: "link",
            value: "javascript:alert(document.cookie)",
          },
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe?.contentWindow,
          data: {
            type: "helix-mail-renderer",
            channel,
            kind: "link",
            value: "https://example.com/report",
          },
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("opens outside Helix");
    const openLink = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/report"]',
    );
    expect(openLink?.target).toBe("_blank");
    expect(openLink?.rel).toBe("noopener noreferrer");
  });
});

function click(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  act(() => {
    button.click();
  });
}
