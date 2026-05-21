import { describe, expect, it } from "vitest";
import {
  CORE_APP_IDS,
  CoreAppRegistrationPlan,
  CoreAppRoleError,
  isCoreAppEnabled,
  isCoreAppId,
  resolveCoreAppStatuses,
  resolveRoleAppSet,
} from "./core-apps.js";

describe("core-app enablement", () => {
  it("defaults every core app to enabled when no module config is present", () => {
    const plan = new CoreAppRegistrationPlan({});
    for (const appId of CORE_APP_IDS) {
      expect(plan.isEnabled(appId)).toBe(true);
      expect(plan.shouldRegister(appId)).toBe(true);
    }
    expect(plan.registeredAppIds()).toEqual([...CORE_APP_IDS]);
  });

  it("treats a core app as enabled unless explicitly disabled", () => {
    expect(isCoreAppEnabled({ mail: {} }, "mail")).toBe(true);
    expect(isCoreAppEnabled({ mail: { enabled: true } }, "mail")).toBe(true);
    expect(isCoreAppEnabled({ mail: { enabled: false } }, "mail")).toBe(false);
    expect(isCoreAppEnabled(undefined, "chat")).toBe(true);
  });

  it("does not register a disabled core app", () => {
    const plan = new CoreAppRegistrationPlan({
      modules: { chat: { enabled: false }, meet: { enabled: false } },
    });
    expect(plan.isEnabled("chat")).toBe(false);
    expect(plan.shouldRegister("chat")).toBe(false);
    expect(plan.shouldRegister("meet")).toBe(false);
    // Other apps remain enabled.
    expect(plan.shouldRegister("mail")).toBe(true);
    expect(plan.registeredAppIds()).not.toContain("chat");
    expect(plan.registeredAppIds()).toContain("mail");
  });

  it("reports per-app status with enabled/inRole/registered", () => {
    const { statuses } = resolveCoreAppStatuses({
      modules: { drive: { enabled: false } },
    });
    const drive = statuses.find((status) => status.id === "drive");
    expect(drive).toMatchObject({ enabled: false, inRole: true, registered: false });
    const mail = statuses.find((status) => status.id === "mail");
    expect(mail).toMatchObject({ enabled: true, inRole: true, registered: true });
  });
});

describe("role-based boot", () => {
  it("the default role runs every core app", () => {
    const { role, appIds } = resolveRoleAppSet({});
    expect(role).toBe("all");
    expect([...appIds].sort()).toEqual([...CORE_APP_IDS].sort());
  });

  it("a named role runs only its subset of apps", () => {
    const plan = new CoreAppRegistrationPlan({ role: "realtime" });
    expect(plan.role).toBe("realtime");
    expect(plan.shouldRegister("chat")).toBe(true);
    expect(plan.shouldRegister("meet")).toBe(true);
    expect(plan.shouldRegister("mail")).toBe(false);
    expect(plan.shouldRegister("docs")).toBe(false);
    expect([...plan.registeredAppIds()].sort()).toEqual(["chat", "meet"]);
  });

  it("HELIX_APPS overrides the role with an explicit subset", () => {
    const { role, appIds } = resolveRoleAppSet({ role: "realtime", apps: "mail,docs" });
    expect(role).toBe("custom");
    expect([...appIds].sort()).toEqual(["docs", "mail"]);
  });

  it("an out-of-role app is not registered even when enabled", () => {
    const plan = new CoreAppRegistrationPlan({ apps: "chat,meet" });
    // mail is enabled org-wide but not in this role.
    expect(plan.isEnabled("mail")).toBe(true);
    expect(plan.status("mail").inRole).toBe(false);
    expect(plan.shouldRegister("mail")).toBe(false);
  });

  it("enablement AND role are both required to register an app", () => {
    const plan = new CoreAppRegistrationPlan({
      modules: { chat: { enabled: false } },
      apps: "chat,meet",
    });
    // chat is in-role but disabled => not registered.
    expect(plan.shouldRegister("chat")).toBe(false);
    // meet is in-role and enabled => registered.
    expect(plan.shouldRegister("meet")).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(() => resolveRoleAppSet({ role: "bogus" })).toThrow(CoreAppRoleError);
  });

  it("rejects an unknown app in HELIX_APPS", () => {
    expect(() => resolveRoleAppSet({ apps: "mail,notanapp" })).toThrow(CoreAppRoleError);
  });

  it("rejects an empty explicit app set", () => {
    expect(() => resolveRoleAppSet({ apps: " , " })).toThrow(CoreAppRoleError);
  });
});

describe("isCoreAppId", () => {
  it("recognizes the seven core apps", () => {
    for (const appId of CORE_APP_IDS) {
      expect(isCoreAppId(appId)).toBe(true);
    }
    expect(isCoreAppId("webhook")).toBe(false);
    expect(isCoreAppId("")).toBe(false);
  });
});
