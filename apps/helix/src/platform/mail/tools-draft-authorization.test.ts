import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { MailStore } from "./store.js";
import { createMailToolDefinitions } from "./tools.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actor = (type: Actor["type"]): Actor => ({
  id: "22222222-2222-4222-8222-222222222222",
  orgId,
  type,
  scopes: ["mail.read", "mail.write"],
});

function tool(id: string, draftsRunUnattended?: (org: string) => Promise<boolean>) {
  const found = createMailToolDefinitions({
    store: {} as MailStore,
    defaultFromDomain: "helix.example",
    ...(draftsRunUnattended === undefined ? {} : { draftsRunUnattended }),
  }).find((definition) => definition.id === id);
  if (found === undefined) throw new Error(`No tool ${id}.`);
  return found;
}

describe("what an agent may do with its mail without a person confirming", () => {
  it("saves drafts in its own mailbox when the organization allows it", async () => {
    const asked: string[] = [];
    const save = tool("mail.draft.save", async (org) => {
      asked.push(org);
      return true;
    });
    await expect(save.standingAuthorization?.({}, actor("agent"))).resolves.toMatchObject({
      id: "agent-own-drafts",
      requestsPerMinute: 30,
    });
    expect(asked).toEqual([orgId]);
    // The organization can ask for every draft to be confirmed instead.
    await expect(
      tool("mail.draft.save", async () => false).standingAuthorization?.({}, actor("agent")),
    ).resolves.toBeNull();
    // With no setting wired at all, nothing is taken for granted.
    await expect(
      tool("mail.draft.save").standingAuthorization?.({}, actor("agent")),
    ).resolves.toBeNull();
  });

  it("never sends without one", () => {
    for (const id of ["mail.send", "mail.reply"]) {
      expect(tool(id, async () => true).standingAuthorization).toBeUndefined();
    }
  });
});
