/** Chat-turn attachment caps. Open WebUI defaults are unlimited; these keep inline context bounded. */
export const assistantAttachmentLimits = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxBodyChars: 500_000,
  scanChars: 100_000,
} as const;
