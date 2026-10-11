import { expect, it } from "vitest";
import { APPS, appForRoute } from "./apps";

it("exposes communication and storage without editors", () => {
  expect(APPS.map((app) => app.id)).toEqual([
    "mail",
    "calendar",
    "drive",
    "chat",
    "meet",
    "assistant",
    "admin",
  ]);
});

it("pins the everyday communication apps and keeps the rest in the launcher", () => {
  expect(APPS.filter((app) => app.pinned).map((app) => app.id)).toEqual([
    "mail",
    "calendar",
    "drive",
    "chat",
    "meet",
  ]);
});

it("resolves nested routes to their app", () => {
  expect(appForRoute("/admin/users")?.id).toBe("admin");
  expect(appForRoute("/search")).toBeUndefined();
});
