export interface PlatformCapability {
  readonly kind: string;
  readonly name: string;
  readonly description?: string;
}

export interface CapabilityKey<
  Kind extends string = string,
  Name extends string = string,
> {
  readonly kind: Kind;
  readonly name: Name;
}

export interface CapabilityAttribution {
  readonly pluginId?: string;
}

export interface CapabilityRegistration<Capability extends PlatformCapability = PlatformCapability> {
  readonly capability: Capability;
  readonly key: CapabilityKey<Capability["kind"], Capability["name"]>;
  readonly pluginId?: string;
}

export interface CapabilityListOptions<Capability extends PlatformCapability = PlatformCapability> {
  readonly kind?: Capability["kind"];
  readonly pluginId?: string;
}

export class DuplicateCapabilityRegistrationError extends Error {
  constructor(
    readonly key: CapabilityKey,
    readonly existingPluginId?: string,
  ) {
    const owner = existingPluginId === undefined ? "" : ` from plugin ${existingPluginId}`;
    super(`Capability already registered: ${capabilityKeyToString(key)}${owner}`);
    this.name = "DuplicateCapabilityRegistrationError";
  }
}

export class CapabilityRegistry<Capability extends PlatformCapability = PlatformCapability> {
  readonly #registrations = new Map<string, CapabilityRegistration<Capability>>();

  register<RegisteredCapability extends Capability>(
    capability: RegisteredCapability,
    attribution: CapabilityAttribution = {},
  ): CapabilityRegistration<RegisteredCapability> {
    const key = capabilityKey(capability);
    const serializedKey = capabilityKeyToString(key);
    const existing = this.#registrations.get(serializedKey);
    if (existing !== undefined) {
      throw new DuplicateCapabilityRegistrationError(key, existing.pluginId);
    }

    const registration = {
      capability,
      key,
      ...(attribution.pluginId === undefined ? {} : { pluginId: attribution.pluginId }),
    } satisfies CapabilityRegistration<RegisteredCapability>;

    this.#registrations.set(serializedKey, registration);
    return registration;
  }

  unregister(key: CapabilityKey<Capability["kind"], Capability["name"]>): boolean {
    return this.#registrations.delete(capabilityKeyToString(key));
  }

  get<
    Kind extends Capability["kind"],
    Name extends Extract<Capability, { readonly kind: Kind }>["name"],
  >(key: CapabilityKey<Kind, Name>): Extract<Capability, { readonly kind: Kind; readonly name: Name }> | undefined {
    return this.getRegistration(key)?.capability;
  }

  getRegistration<
    Kind extends Capability["kind"],
    Name extends Extract<Capability, { readonly kind: Kind }>["name"],
  >(key: CapabilityKey<Kind, Name>): CapabilityRegistration<
    Extract<Capability, { readonly kind: Kind; readonly name: Name }>
  > | undefined {
    return this.#registrations.get(capabilityKeyToString(key)) as
      | CapabilityRegistration<Extract<Capability, { readonly kind: Kind; readonly name: Name }>>
      | undefined;
  }

  list(options: CapabilityListOptions<Capability> = {}): readonly Capability[] {
    return this.listRegistrations(options).map((registration) => registration.capability);
  }

  listRegistrations(options: CapabilityListOptions<Capability> = {}): readonly CapabilityRegistration<Capability>[] {
    return [...this.#registrations.values()]
      .filter((registration) => matchesListOptions(registration, options))
      .sort((left, right) => capabilityKeyToString(left.key).localeCompare(capabilityKeyToString(right.key)));
  }
}

export function capabilityKey<Capability extends PlatformCapability>(
  capability: Capability,
): CapabilityKey<Capability["kind"], Capability["name"]> {
  return { kind: capability.kind, name: capability.name };
}

export function capabilityKeyToString(key: CapabilityKey): string {
  return `${key.kind}:${key.name}`;
}

function matchesListOptions<Capability extends PlatformCapability>(
  registration: CapabilityRegistration<Capability>,
  options: CapabilityListOptions<Capability>,
): boolean {
  if (options.kind !== undefined && registration.key.kind !== options.kind) {
    return false;
  }
  if (options.pluginId !== undefined && registration.pluginId !== options.pluginId) {
    return false;
  }
  return true;
}
