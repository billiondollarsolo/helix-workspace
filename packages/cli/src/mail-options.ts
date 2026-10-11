/**
 * Flag-to-field maps for the mail commands. Field names must match the mail tool
 * input schemas (`mail.send`, `mail.reply`, `mail.threads.list`, `mail.search`);
 * completion derives its flags from these same maps so the two cannot drift.
 */
export type MailOptionSpec = {
  readonly arrays: ReadonlyMap<string, string>;
  readonly strings: ReadonlyMap<string, string>;
  readonly numbers: ReadonlyMap<string, string>;
  /** Mail sends from API credentials need an idempotency key; generate one when absent. */
  readonly idempotent?: boolean;
};

export const mailSendOptions = {
  arrays: new Map([
    ["--to", "to"],
    ["--cc", "cc"],
    ["--bcc", "bcc"],
  ]),
  strings: new Map([
    ["--from", "from"],
    ["--subject", "subject"],
    ["--body", "bodyText"],
    ["--html", "bodyHtml"],
    ["--idempotency-key", "idempotencyKey"],
  ]),
  numbers: new Map<string, string>(),
  idempotent: true,
} as const;

export const mailReplyOptions = {
  arrays: new Map([
    ["--to", "to"],
    ["--cc", "cc"],
    ["--bcc", "bcc"],
  ]),
  strings: new Map([
    ["--thread-id", "threadId"],
    ["--in-reply-to", "inReplyTo"],
    ["--subject", "subject"],
    ["--body", "bodyText"],
    ["--html", "bodyHtml"],
    ["--idempotency-key", "idempotencyKey"],
  ]),
  numbers: new Map<string, string>(),
  idempotent: true,
} as const;

export const mailListOptions = {
  arrays: new Map<string, string>(),
  strings: new Map([
    ["--folder", "folder"],
    // `--mailbox` named the folder before mail.threads.list existed.
    ["--mailbox", "folder"],
    ["--label", "label"],
    ["--query", "query"],
  ]),
  numbers: new Map([
    ["--limit", "limit"],
    ["--offset", "offset"],
  ]),
} as const;

export const mailSearchOptions = {
  arrays: new Map([["--label", "labels"]]),
  strings: new Map([["--query", "query"]]),
  numbers: new Map([["--limit", "limit"]]),
} as const;

function mailOptionFlags(spec: MailOptionSpec): readonly string[] {
  return [...spec.arrays.keys(), ...spec.strings.keys(), ...spec.numbers.keys(), "--json"];
}

export const mailCompletionFlags: Record<string, readonly string[]> = {
  send: mailOptionFlags(mailSendOptions),
  reply: mailOptionFlags(mailReplyOptions),
  list: mailOptionFlags(mailListOptions),
  search: mailOptionFlags(mailSearchOptions),
};
