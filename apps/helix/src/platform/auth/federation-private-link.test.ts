import { describe, expect, it, vi } from "vitest";
import { OutboundHttpError } from "../outbound-http.js";
import type { FederationApplicationRow } from "./federation-pairing.js";
import {
  PRIVATE_LINK_RECHECK_MS,
  privateLinkDue,
  privateLinkInput,
  privateLinkView,
  targetFromUrl,
  withPrivateFallback,
} from "./federation-private-link.js";

const row = (overrides: Partial<FederationApplicationRow> = {}) =>
  ({
    public_origin: "https://agentspace.example",
    private_target: null,
    private_target_source: null,
    private_target_checked_at: null,
    private_target_error: null,
    ...overrides,
  }) as FederationApplicationRow;

describe("federated app private links", () => {
  it("turns advertised https origins into host:port targets", () => {
    expect(targetFromUrl("https://helix-agentspace:3000")).toBe("helix-agentspace:3000");
    expect(targetFromUrl("https://agentspace.tailnet.ts.net")).toBe(
      "agentspace.tailnet.ts.net:443",
    );
    expect(targetFromUrl("http://helix-agentspace:3000")).toBeNull();
    expect(targetFromUrl("https://user:pass@host:1")).toBeNull();
    expect(targetFromUrl("not a url")).toBeNull();
  });

  it("accepts only host:port from admins", () => {
    expect(privateLinkInput.parse({ target: " 10.0.0.5:3000 " }).target).toBe("10.0.0.5:3000");
    for (const target of ["https://x:1", "host", "host:0", "host:70000", "a b:1"])
      expect(privateLinkInput.safeParse({ target }).success).toBe(false);
  });

  it("reports the connection path admins see", () => {
    expect(privateLinkView(new Map(), row())).toMatchObject({ path: "public", target: null });
    expect(
      privateLinkView(
        new Map(),
        row({ private_target: "helix-agentspace:3000", private_target_source: "discovered" }),
      ),
    ).toMatchObject({ path: "private", target: "helix-agentspace:3000", source: "discovered" });
    expect(
      privateLinkView(
        new Map(),
        row({ private_target: "helix-agentspace:3000", private_target_error: "down" }),
      ),
    ).toMatchObject({ path: "public", error: "down" });
    expect(
      privateLinkView(new Map([["agentspace.example", { host: "10.0.0.5", port: 3000 }]]), row()),
    ).toMatchObject({ path: "private", target: "10.0.0.5:3000", source: "configured" });
  });

  it("re-checks links after the recheck interval", () => {
    const now = Date.now();
    expect(privateLinkDue(row(), now)).toBe(true);
    expect(privateLinkDue(row({ private_target_checked_at: new Date(now - 1000) }), now)).toBe(
      false,
    );
    expect(
      privateLinkDue(
        row({ private_target_checked_at: new Date(now - PRIVATE_LINK_RECHECK_MS) }),
        now,
      ),
    ).toBe(true);
  });

  it("falls back to the public origin only when a learned route can't connect", async () => {
    const url = "https://agentspace.example/v1/federation/x/challenge";
    const unreachable = () =>
      Promise.reject(new OutboundHttpError("transport_failed", new URL(url)));
    const direct = vi.fn(async () => new Response("public"));
    const onFailure = vi.fn();

    const learned = withPrivateFallback(unreachable, direct, () => true, onFailure);
    await expect((await learned(url, { method: "POST" })).text()).resolves.toBe("public");
    expect(onFailure).toHaveBeenCalledWith("agentspace.example");

    const notLearned = withPrivateFallback(unreachable, direct, () => false, onFailure);
    await expect(notLearned(url)).rejects.toMatchObject({ code: "transport_failed" });

    const refused = withPrivateFallback(
      () => Promise.reject(new OutboundHttpError("blocked_destination", new URL(url))),
      direct,
      () => true,
      onFailure,
    );
    await expect(refused(url)).rejects.toMatchObject({ code: "blocked_destination" });
    expect(direct).toHaveBeenCalledTimes(1);
  });
});
