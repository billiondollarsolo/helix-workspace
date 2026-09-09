import { expect, it } from "vitest";
import { APPS } from "./apps";
it("exposes communication and storage without editors", () => {
  expect(APPS.map((app) => app.id)).toEqual([
    "mail",
    "calendar",
    "drive",
    "meet",
    "chat",
    "assistant",
    "admin",
  ]);
});
