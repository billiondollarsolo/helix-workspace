import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CapabilityRegistry,
  DuplicateCapabilityRegistrationError,
  capabilityKey,
  capabilityKeyToString,
  type PlatformCapability,
} from "./registry.js";

interface ObjectStoreCapability extends PlatformCapability {
  readonly kind: "storage";
  readonly name: "object-store";
  readonly put: (key: string, value: Uint8Array) => Promise<void>;
}

interface AuditSinkCapability extends PlatformCapability {
  readonly kind: "audit";
  readonly name: "sink";
  readonly write: (event: string) => Promise<void>;
}

type TestCapability = ObjectStoreCapability | AuditSinkCapability;

const objectStore: ObjectStoreCapability = {
  kind: "storage",
  name: "object-store",
  description: "Object storage",
  put: async () => {},
};

const auditSink: AuditSinkCapability = {
  kind: "audit",
  name: "sink",
  write: async () => {},
};

describe("CapabilityRegistry", () => {
  it("registers and retrieves capabilities by kind and name", () => {
    const registry = new CapabilityRegistry<TestCapability>();

    registry.register(objectStore);

    const capability = registry.get({ kind: "storage", name: "object-store" });
    expect(capability).toBe(objectStore);
    expectTypeOf(capability).toEqualTypeOf<ObjectStoreCapability | undefined>();
  });

  it("throws a duplicate registration error for the same kind and name", () => {
    const registry = new CapabilityRegistry<TestCapability>();
    registry.register(objectStore, { pluginId: "plugin.storage" });

    expect(() => registry.register(objectStore)).toThrow(DuplicateCapabilityRegistrationError);
    expect(() => registry.register(objectStore)).toThrow(
      "Capability already registered: storage:object-store from plugin plugin.storage",
    );
  });

  it("unregisters capabilities by kind and name", () => {
    const registry = new CapabilityRegistry<TestCapability>();
    registry.register(objectStore);

    expect(registry.unregister({ kind: "storage", name: "object-store" })).toBe(true);
    expect(registry.get({ kind: "storage", name: "object-store" })).toBeUndefined();
    expect(registry.unregister({ kind: "storage", name: "object-store" })).toBe(false);
  });

  it("lists capabilities in stable key order with optional filters", () => {
    const registry = new CapabilityRegistry<TestCapability>();
    registry.register(objectStore, { pluginId: "plugin.storage" });
    registry.register(auditSink, { pluginId: "plugin.audit" });

    expect(registry.list()).toEqual([auditSink, objectStore]);
    expect(registry.list({ kind: "storage" })).toEqual([objectStore]);
    expect(registry.list({ pluginId: "plugin.audit" })).toEqual([auditSink]);
  });

  it("exposes plugin attribution on registrations", () => {
    const registry = new CapabilityRegistry<TestCapability>();
    registry.register(objectStore, { pluginId: "plugin.storage" });

    expect(registry.getRegistration({ kind: "storage", name: "object-store" })).toEqual({
      capability: objectStore,
      key: { kind: "storage", name: "object-store" },
      pluginId: "plugin.storage",
    });
  });

  it("formats capability keys", () => {
    expect(capabilityKey(objectStore)).toEqual({ kind: "storage", name: "object-store" });
    expect(capabilityKeyToString({ kind: "storage", name: "object-store" })).toBe("storage:object-store");
  });
});
