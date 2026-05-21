import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { simpleYamlParser } from "../config/loader.js";
import { sha256Hex } from "../crypto/index.js";

const execFileAsync = promisify(execFile);

export interface SecretSnapshot {
  readonly version: string;
  readonly values: ReadonlyMap<string, string>;
}

export interface SecretsAdapter {
  load(): Promise<SecretSnapshot>;
  get(name: string): Promise<string | undefined>;
  require(name: string): Promise<string>;
}

export interface SopsSecretsAdapterOptions {
  readonly filePath: string;
  readonly format?: "json" | "yaml";
  readonly requiredKeys?: readonly string[];
  readonly decrypt?: SopsDecryptor;
  readonly allowNested?: boolean;
}

export type SopsDecryptor = (filePath: string) => Promise<string>;

export class SopsSecretsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SopsSecretsValidationError";
  }
}

export class SopsFileSecretsAdapter implements SecretsAdapter {
  readonly #options: {
    readonly filePath: string;
    readonly format: "json" | "yaml" | undefined;
    readonly requiredKeys: readonly string[];
    readonly decrypt: SopsDecryptor;
    readonly allowNested: boolean;
  };

  constructor(options: SopsSecretsAdapterOptions) {
    if (options.filePath.length === 0) {
      throw new TypeError("SOPS secrets filePath is required");
    }

    this.#options = {
      filePath: options.filePath,
      format: options.format,
      requiredKeys: options.requiredKeys ?? [],
      decrypt: options.decrypt ?? decryptWithSopsCli,
      allowNested: options.allowNested ?? false,
    };
  }

  async load(): Promise<SecretSnapshot> {
    const raw = await readFile(this.#options.filePath, "utf8");
    const plaintext = looksEncryptedSops(raw) ? await this.#options.decrypt(this.#options.filePath) : raw;
    const parsed = parseSecretDocument(plaintext, this.#options.filePath, this.#options.format);
    const values = normalizeSecrets(parsed, {
      label: this.#options.filePath,
      requiredKeys: this.#options.requiredKeys,
      allowNested: this.#options.allowNested,
    });

    return {
      version: sha256Version(plaintext),
      values,
    };
  }

  async get(name: string): Promise<string | undefined> {
    validateSecretName(name);
    return (await this.load()).values.get(name);
  }

  async require(name: string): Promise<string> {
    const value = await this.get(name);
    if (value === undefined) {
      throw new SopsSecretsValidationError(`Required secret ${name} is missing`);
    }
    return value;
  }
}

export function createSopsSecretsAdapter(options: SopsSecretsAdapterOptions): SecretsAdapter {
  return new SopsFileSecretsAdapter(options);
}

async function decryptWithSopsCli(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("sops", ["--decrypt", filePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new SopsSecretsValidationError(`Failed to decrypt SOPS secrets file ${filePath}: ${message}`);
  }
}

function parseSecretDocument(text: string, label: string, format: "json" | "yaml" | undefined): unknown {
  try {
    if ((format ?? inferFormat(label)) === "json") {
      return JSON.parse(text);
    }

    return simpleYamlParser.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid syntax";
    throw new SopsSecretsValidationError(`Failed to parse secrets file ${label}: ${message}`);
  }
}

function inferFormat(filePath: string): "json" | "yaml" {
  return filePath.endsWith(".json") ? "json" : "yaml";
}

function normalizeSecrets(
  value: unknown,
  options: {
    readonly label: string;
    readonly requiredKeys: readonly string[];
    readonly allowNested: boolean;
  },
): ReadonlyMap<string, string> {
  if (!isPlainObject(value)) {
    throw new SopsSecretsValidationError(`${options.label} must contain a secrets object`);
  }

  const secrets = new Map<string, string>();
  collectSecrets(value, "", secrets, options);

  for (const key of options.requiredKeys) {
    validateSecretName(key);
    if (!secrets.has(key)) {
      throw new SopsSecretsValidationError(`Required secret ${key} is missing from ${options.label}`);
    }
  }

  return secrets;
}

function collectSecrets(
  input: Record<string, unknown>,
  prefix: string,
  output: Map<string, string>,
  options: {
    readonly label: string;
    readonly allowNested: boolean;
  },
): void {
  for (const [key, value] of Object.entries(input)) {
    if (key === "sops") {
      continue;
    }

    const name = prefix.length === 0 ? key : `${prefix}.${key}`;
    validateSecretName(name);

    if (typeof value === "string") {
      if (looksEncryptedValue(value)) {
        throw new SopsSecretsValidationError(`Secret ${name} in ${options.label} is still encrypted`);
      }
      output.set(name, value);
      continue;
    }

    if (options.allowNested && isPlainObject(value)) {
      collectSecrets(value, name, output, options);
      continue;
    }

    throw new SopsSecretsValidationError(`Secret ${name} in ${options.label} must be a string`);
  }
}

function validateSecretName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new SopsSecretsValidationError(`Invalid secret name ${name}`);
  }
}

function looksEncryptedSops(text: string): boolean {
  return text.includes("ENC[") || /(^|\n)\s*sops\s*:/.test(text) || /"sops"\s*:/.test(text);
}

function looksEncryptedValue(value: string): boolean {
  return value.trimStart().startsWith("ENC[");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Version(text: string): string {
  return `sops-file:${sha256Hex(text)}`;
}
