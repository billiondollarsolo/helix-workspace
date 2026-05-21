# Drive LibreOffice Preview

External-service plugin scaffold for converting Office documents to PDF previews.

The service is intentionally separate from the main Helix container because LibreOffice conversion is heavier and benefits from an isolated filesystem, memory limits, and a narrow permission set. The compose recipe exposes port `28450` by default, contiguous with the base stack's high ports.

Expected service contract:

- `GET /readyz` returns service readiness.
- `POST /preview/office-to-pdf` accepts a storage object reference and returns a generated PDF preview reference.
- The container performs conversion inside `DRIVE_PREVIEW_WORKDIR` and deletes temporary files after each request.
