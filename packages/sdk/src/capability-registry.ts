import type { PlatformCapabilities } from "@helix/sdk-types";

export type CapabilityName = keyof PlatformCapabilities;

export interface CapabilityRegistrySnapshot {
  readonly required: readonly CapabilityName[];
  readonly optional: readonly CapabilityName[];
  readonly registered: readonly CapabilityName[];
  readonly missingRequired: readonly CapabilityName[];
}

export class CapabilityRegistry {
  readonly #capabilities = new Map<CapabilityName, PlatformCapabilities[CapabilityName]>();
  readonly #required = new Set<CapabilityName>();
  readonly #optional = new Set<CapabilityName>();

  require(name: CapabilityName): void {
    this.#required.add(name);
  }

  markOptional(name: CapabilityName): void {
    this.#optional.add(name);
  }

  register<Name extends CapabilityName>(name: Name, capability: NonNullable<PlatformCapabilities[Name]>): void {
    this.#capabilities.set(name, capability);
  }

  unregister(name: CapabilityName): void {
    this.#capabilities.delete(name);
  }

  get<Name extends CapabilityName>(name: Name): PlatformCapabilities[Name] | undefined {
    return this.#capabilities.get(name) as PlatformCapabilities[Name] | undefined;
  }

  requireCapability<Name extends CapabilityName>(name: Name): NonNullable<PlatformCapabilities[Name]> {
    const capability = this.get(name);
    if (capability === undefined) {
      throw new Error(`Required capability is not registered: ${name}`);
    }

    return capability;
  }

  snapshot(): CapabilityRegistrySnapshot {
    const registered = [...this.#capabilities.keys()].sort();
    const required = [...this.#required].sort();
    const optional = [...this.#optional].sort();
    const missingRequired = required.filter((name) => !this.#capabilities.has(name));

    return { required, optional, registered, missingRequired };
  }
}
