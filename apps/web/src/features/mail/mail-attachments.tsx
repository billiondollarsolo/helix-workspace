/* Attachments under a message: a chip per file (type icon, name, size) that
   downloads it, "Download all" when there are several, and inline images
   (`Content-Disposition: inline` images) drawn below the text. There are no
   file previews; the download route serves only scanned, clean files. */

import { apiPath } from "@/lib/auth";
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import type { MailMessageAttachment } from "./api";
import { followLink, formatBytes } from "./mail-view-helpers";

function iconFor(mimeType: string): LucideIcon {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType.startsWith("video/")) return FileVideo;
  if (mimeType.startsWith("audio/")) return FileAudio;
  if (/zip|compressed|tar|gzip|7z|rar/u.test(mimeType)) return FileArchive;
  if (/sheet|excel|csv/u.test(mimeType)) return FileSpreadsheet;
  if (mimeType.startsWith("text/") || /pdf|word|document|rtf/u.test(mimeType)) return FileText;
  return File;
}

function downloadHref(attachment: MailMessageAttachment): string {
  return apiPath(attachment.downloadUrl);
}

function inlineHref(attachment: MailMessageAttachment): string {
  const href = downloadHref(attachment);
  return `${href}${href.includes("?") ? "&" : "?"}inline=true`;
}

/** Inline images that the message body refers to, drawn as passive images. */
function inlineImages(
  attachments: readonly MailMessageAttachment[],
): readonly MailMessageAttachment[] {
  return attachments.filter(
    (attachment) => attachment.inline && attachment.mimeType.startsWith("image/"),
  );
}

export function MailAttachments({
  attachments,
}: {
  readonly attachments: readonly MailMessageAttachment[];
}) {
  const images = inlineImages(attachments);
  const files = attachments.filter((attachment) => !images.includes(attachment));
  if (attachments.length === 0) return null;

  const downloadAll = () => {
    // One click per file: browsers allow sequential downloads from a user gesture.
    for (const attachment of files) {
      followLink(downloadHref(attachment), { download: attachment.filename ?? "" });
    }
  };

  return (
    <div className="mail-attachments">
      {images.length === 0 ? null : (
        <div className="mail-inline-images">
          {images.map((image) => (
            <img
              key={image.objectId}
              src={inlineHref(image)}
              alt={image.filename ?? "Inline image"}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="mail-inline-image"
            />
          ))}
        </div>
      )}
      {files.length === 0 ? null : (
        <>
          <div className="mail-attachments-head">
            <span className="type-meta font-semibold">
              {files.length === 1 ? "One attachment" : `${String(files.length)} attachments`}
            </span>
            {files.length > 1 ? (
              <button type="button" className="mail-link focus-ring" onClick={downloadAll}>
                Download all
              </button>
            ) : null}
          </div>
          <ul className="mail-attachment-list">
            {files.map((attachment) => {
              const Icon = iconFor(attachment.mimeType);
              const name = attachment.filename ?? "Untitled attachment";
              return (
                <li key={attachment.objectId}>
                  <a
                    className="mail-attachment focus-ring"
                    href={downloadHref(attachment)}
                    download={attachment.filename ?? ""}
                    rel="noopener"
                    aria-label={`Download ${name}, ${formatBytes(attachment.byteSize)}`}
                  >
                    <Icon aria-hidden="true" className="mail-attachment-icon" />
                    <span className="mail-attachment-text">
                      <span className="mail-attachment-name">{name}</span>
                      <span className="mail-attachment-size">
                        {formatBytes(attachment.byteSize)}
                      </span>
                    </span>
                    <Download aria-hidden="true" className="mail-attachment-download" />
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
