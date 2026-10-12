// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useServerSeededDraft, type ServerSeededDraft } from "./use-server-seeded-draft";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Server {
  readonly name: string;
}

interface Draft {
  readonly name: string;
  readonly row: number;
}

let rowCounter = 0;
const toDraft = (server: Server | undefined): Draft => {
  rowCounter += 1;
  return { name: server?.name ?? "", row: rowCounter };
};

let latest: ServerSeededDraft<Draft>;
function Probe({ server }: { readonly server: Server | undefined }) {
  latest = useServerSeededDraft(server, toDraft);
  return null;
}

let primitive: ServerSeededDraft<string> | undefined;
function PrimitiveProbe({ server }: { readonly server: string }) {
  primitive = useServerSeededDraft(server, (value) => value);
  return null;
}

describe("useServerSeededDraft", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (server: Server | undefined) => {
    act(() => {
      root.render(createElement(Probe, { server }));
    });
  };
  const type = (name: string) => {
    act(() => {
      latest.setDraft((current) => ({ ...current, name }));
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  it("seeds from the first server value, even over edits made before it loaded", () => {
    render(undefined);
    expect(latest.draft.name).toBe("");
    type("typed while loading");
    render({ name: "alpha" });
    expect(latest.draft.name).toBe("alpha");
    expect(latest.isDirty).toBe(false);
  });

  it("follows new server values while clean", () => {
    render({ name: "alpha" });
    render({ name: "beta" });
    expect(latest.draft.name).toBe("beta");
    expect(latest.baseline.name).toBe("beta");
  });

  it("does not re-seed (or mint new rows) when a refetch returns the same reference", () => {
    const server = { name: "alpha" };
    render(server);
    const seeded = latest.draft;
    render(server);
    expect(latest.draft).toBe(seeded);
  });

  it("keeps unsaved edits when a newer server value arrives, measured against the original baseline", () => {
    render({ name: "alpha" });
    const { row } = latest.draft;
    type("alpha edited");
    render({ name: "beta" });
    expect(latest.draft).toEqual({ name: "alpha edited", row });
    expect(latest.isDirty).toBe(true);
    expect(latest.baseline.name).toBe("alpha");
  });

  it("re-seeds after this form's own save once the server catches up", () => {
    render({ name: "alpha" });
    type("saved name");
    const submitted = latest.draft;
    act(() => {
      latest.markSaved(submitted);
    });
    // Saved but the refetch has not landed: the submitted text stays on screen.
    expect(latest.draft.name).toBe("saved name");
    expect(latest.isDirty).toBe(false);
    render({ name: "saved name (normalized)" });
    expect(latest.draft.name).toBe("saved name (normalized)");
  });

  it("re-seeds immediately when the save's refetch landed before markSaved", () => {
    render({ name: "alpha" });
    type("saved name");
    const submitted = latest.draft;
    render({ name: "saved name (server)" });
    expect(latest.draft.name).toBe("saved name");
    act(() => {
      latest.markSaved(submitted);
    });
    expect(latest.draft.name).toBe("saved name (server)");
    expect(latest.isDirty).toBe(false);
  });

  it("keeps text typed while the save was in flight", () => {
    render({ name: "alpha" });
    type("submitted");
    const submitted = latest.draft;
    type("submitted and more");
    act(() => {
      latest.markSaved(submitted);
    });
    render({ name: "submitted" });
    expect(latest.draft.name).toBe("submitted and more");
    expect(latest.baseline).toBe(submitted);
  });

  it("reset discards edits and follows the latest server value", () => {
    render({ name: "alpha" });
    type("edited");
    render({ name: "beta" });
    act(() => {
      latest.reset();
    });
    expect(latest.draft.name).toBe("beta");
    expect(latest.isDirty).toBe(false);
  });

  it("treats a primitive draft typed back to its baseline as clean", () => {
    act(() => {
      root.render(createElement(PrimitiveProbe, { server: "secondary" }));
    });
    act(() => {
      primitive?.setDraft("alias");
    });
    expect(primitive?.isDirty).toBe(true);
    act(() => {
      primitive?.setDraft("secondary");
    });
    act(() => {
      root.render(createElement(PrimitiveProbe, { server: "alias" }));
    });
    expect(primitive?.draft).toBe("alias");
  });
});
