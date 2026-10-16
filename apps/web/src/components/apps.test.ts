import { expect, it } from "vitest";
import { APPS, appForRoute } from "./apps";

it("exposes communication and storage without editors", () => {
  expect(APPS.map((app) => app.id)).toEqual([
    "mail",
    "calendar",
    "drive",
    "chat",
    "meet",
    "contacts",
    "passwords",
    "assistant",
    "admin",
  ]);
});

it("pins the everyday workspace apps and keeps the rest in the launcher", () => {
  expect(APPS.filter((app) => app.pinned).map((app) => app.id)).toEqual([
    "mail",
    "calendar",
    "drive",
    "chat",
    "meet",
    "passwords",
    "assistant",
  ]);
});

it("resolves nested routes to their app", () => {
  expect(appForRoute("/admin/users")?.id).toBe("admin");
  expect(appForRoute("/contacts/00000000-0000-4000-8000-000000000001")?.id).toBe("contacts");
  expect(appForRoute("/search")).toBeUndefined();
});
