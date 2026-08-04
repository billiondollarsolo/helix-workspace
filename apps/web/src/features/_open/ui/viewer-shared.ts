/* Small helpers shared by every imported-file viewer under `_open/ui`.
 *
 * Each renderer previously carried its own copy of these two, which meant a
 * byte-size format tweak or a download-route change had to be repeated across
 * a dozen files. */

/** Authenticated download URL for a Drive object, forcing an attachment
 *  response rather than an inline render. */
export function driveDownloadHref(objectId: string): string {
  return `/api/drive/objects/${objectId}/content?download=1`;
}

/** Compact byte-size label: whole bytes under 1 KB, then 1-dp KB, then 2-dp MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
