/* Print the message being composed: headers and the sanitized body in a
   throwaway frame, so the app chrome never ends up on paper. */

import { personRefAddress } from "@/features/people/person-ref";
import type { ComposeFields } from "./compose-fields";
import { escapeHtml, sanitizeComposeHtml } from "./compose-html";

export function printComposedMessage(fields: ComposeFields, from: string): void {
  const header = (label: string, value: string) =>
    value === "" ? "" : `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`;
  const list = (refs: ComposeFields["to"]) => refs.map(personRefAddress).join(", ");
  const frame = document.createElement("iframe");
  frame.title = "Print preview";
  frame.className = "compose-print-frame";
  document.body.append(frame);
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (doc === null || view === null) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fields.subject || "Message")}</title></head><body>` +
      `<h1>${escapeHtml(fields.subject || "(no subject)")}</h1>` +
      header("From", from) +
      header("To", list(fields.to)) +
      header("Cc", list(fields.cc)) +
      header("Bcc", list(fields.bcc)) +
      `<hr>${sanitizeComposeHtml(fields.html)}</body></html>`,
  );
  doc.close();
  view.addEventListener("afterprint", () => {
    frame.remove();
  });
  view.focus();
  view.print();
}
