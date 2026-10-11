/* Print one message or a whole conversation as plain text. The printable
   page is a hidden frame built from DOM text nodes only, so message content
   can never run as markup there. */

import type { MailThreadMessage } from "./api";
import { formatFullDate } from "./mail-view-helpers";

export function messagePlainText(message: MailThreadMessage): string {
  if (message.bodyFormat === "plain") return message.body;
  if (message.plainBody !== undefined) return message.plainBody;
  return new DOMParser().parseFromString(message.body, "text/html").body.textContent?.trim() ?? "";
}

function addressText(address: { readonly address: string; readonly name?: string }): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function printMessages(subject: string, messages: readonly MailThreadMessage[]): void {
  const frame = document.createElement("iframe");
  frame.title = "Print preview";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.append(frame);
  const target = frame.contentWindow;
  if (target === null) {
    frame.remove();
    return;
  }
  const doc = target.document;
  doc.title = subject;
  const style = doc.createElement("style");
  style.textContent =
    "body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:black}h1{font-size:20px}section{border-top:1px solid gray;padding-top:12px;margin-top:12px}dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0 0 12px}dt{font-weight:600}pre{white-space:pre-wrap;font:inherit}";
  doc.head.append(style);
  const heading = doc.createElement("h1");
  heading.textContent = subject;
  doc.body.append(heading);
  for (const message of messages) {
    const section = doc.createElement("section");
    const meta = doc.createElement("dl");
    const fields: [string, string][] = [
      ["From", message.from === undefined ? "" : addressText(message.from)],
      ["To", message.to.map(addressText).join(", ")],
      ["Cc", message.cc.map(addressText).join(", ")],
      ["Date", formatFullDate(message.sentAt)],
    ];
    for (const [term, value] of fields) {
      if (value === "") continue;
      const dt = doc.createElement("dt");
      dt.textContent = term;
      const dd = doc.createElement("dd");
      dd.textContent = value;
      meta.append(dt, dd);
    }
    const body = doc.createElement("pre");
    body.textContent = messagePlainText(message);
    section.append(meta, body);
    doc.body.append(section);
  }
  target.addEventListener("afterprint", () => frame.remove(), { once: true });
  target.focus();
  target.print();
}
