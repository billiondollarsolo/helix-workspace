# Isolated content converter

This service is the only production boundary for Office and HTML-to-PDF conversion. The API sends
bytes over its private conversion network; LibreOffice and PDF inspection never run in the API pod.

Contract:

- `GET /readyz` reports process readiness.
- `POST /convert/office-to-pdf` accepts `{ name, mimeType, contentBase64 }`.
- `POST /convert/html-to-pdf` accepts the same shape with `text/html` content.
- Successful conversion returns `{ pdfBase64, pageCount, generatedAt }`.

The recipe has no published port or external network, runs as UID/GID 65532 with the default seccomp
profile, drops every capability, uses a read-only root filesystem and bounded tmpfs, and applies PID,
CPU, memory, request, source, output, archive, cell, page, and time limits. Production orchestrators
must preserve these controls and allow ingress only from the Helix API while denying all converter
egress.
