import type { ToolContext } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { MailStore } from "./store.js";
import { createMailComposeToolDefinitions } from "./tools-compose.js";
import type { CreateOutboundMailInput } from "./store-contracts.js";

// The CLI sends its key as an Idempotency-Key header, which the registry passes on as
// ctx.idempotencyKey (and keeps across approval). Only the input field used to count,
// so every approved agent/API send failed with "require an idempotency key".
describe("mail.send idempotency for agent and API callers", () => {
  const created: CreateOutboundMailInput[] = [];
  const store = {
    createOutbound: async (input: CreateOutboundMailInput) => {
      created.push(input);
      return {
        id: "o-1",
        messageId: "m-1",
        threadId: "t-1",
        status: "queued",
        undoUntil: new Date(),
        createdAt: new Date(),
      };
    },
  } as unknown as MailStore;
  const send = createMailComposeToolDefinitions({ store, defaultFromDomain: "example.com" }).find(
    (tool) => tool.id === "mail.send",
  );
  const ctx = (idempotencyKey?: string) =>
    ({
      actor: { id: "agent-1", orgId: "org-1", type: "agent", email: "bot@example.com" },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }) as unknown as ToolContext;
  const input = {
    to: [{ address: "ann@example.com" }],
    cc: [],
    bcc: [],
    attachments: [],
    subject: "Hi",
    bodyText: "Hello",
  };

  it("uses the request key when the input carries none, and still requires one", async () => {
    await expect(send?.handler(input, ctx())).rejects.toThrow(/idempotency key/u);
    await send?.handler(input, ctx("cli-key-0001"));
    expect(created.at(-1)?.idempotencyKey).toBe("cli-key-0001");
    await send?.handler({ ...input, idempotencyKey: "input-key-0001" }, ctx("cli-key-0001"));
    expect(created.at(-1)?.idempotencyKey).toBe("input-key-0001");
  });

  it("refuses more recipients than one message may have", async () => {
    const capped = createMailComposeToolDefinitions({
      store,
      defaultFromDomain: "example.com",
      maxRecipients: 2,
    }).find((tool) => tool.id === "mail.send");
    const before = created.length;
    await expect(
      capped?.handler(
        {
          ...input,
          cc: [{ address: "bo@example.com" }],
          bcc: [{ address: "cy@example.com" }],
          idempotencyKey: "cap-key-0001",
        },
        ctx(),
      ),
    ).rejects.toThrow(/at most 2 recipients/u);
    expect(created).toHaveLength(before);
  });
});
