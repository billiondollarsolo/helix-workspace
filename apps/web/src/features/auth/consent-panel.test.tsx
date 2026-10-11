// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, unmountAll } from "@/test/ui";
import { buttonNamed } from "@/features/mail/settings/test-support";
import { ConsentPanel } from "./consent-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const search = {
  response_type: "code",
  client_id: "calendar-sync",
  redirect_uri: "https://client.example/callback",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  scope: "calendar.read calendar.read",
  state: "xyz",
};

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe("ConsentPanel", () => {
  it("names the app and each scope once, and posts the decision back", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);
    mount(<ConsentPanel search={search} />);
    expect(document.querySelector("h1")?.textContent).toBe("Allow access to your account?");
    expect(document.body.textContent).toContain("calendar-sync wants to use your Helix account.");
    expect(Array.from(document.querySelectorAll("ul li")).map((item) => item.textContent)).toEqual([
      "calendar.read",
    ]);
    expect(await axeViolations()).toEqual([]);

    click(buttonNamed("Allow"));
    expect(submit).toHaveBeenCalledTimes(1);
    const form = document.querySelector<HTMLFormElement>('form[action="/v1/oauth/authorize"]');
    expect(new FormData(form ?? undefined).get("decision")).toBe("approve");
    expect(new FormData(form ?? undefined).get("state")).toBe("xyz");
    expect(buttonNamed("Deny")?.disabled).toBe(true);
  });

  it("explains an incomplete request instead of asking for consent", async () => {
    mount(<ConsentPanel search={{ ...search, client_id: "" }} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "missing required parameters",
    );
    expect(buttonNamed("Allow")).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
