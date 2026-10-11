// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createS3AccessKey, listS3AccessKeys, revokeS3AccessKey } from "./s3-keys-api";
import { S3KeysSection } from "./settings-s3-keys";

vi.mock("./s3-keys-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./s3-keys-api")>()),
  listS3AccessKeys: vi.fn(),
  createS3AccessKey: vi.fn(),
  revokeS3AccessKey: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function settle(action: () => void): Promise<void> {
  await act(() => {
    action();
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

const existing = {
  id: "8d4f546c-0dd9-44a4-b95c-d41bf8269301",
  accessKeyId: "HLXAAAAAAAAAAAAAAAAA",
  label: "laptop",
  scopes: ["drive.read"] as const,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-10-11T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(listS3AccessKeys).mockResolvedValue([existing]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("shows the endpoint and lists keys with labelled revoke buttons", async () => {
  await settle(() => root.render(<S3KeysSection />));
  expect(container.textContent).toContain(`${window.location.origin}/v1/s3`);
  expect(container.textContent).toContain("HLXAAAAAAAAAAAAAAAAA");
  const revoke = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Revoke S3 access key laptop"]',
  );
  expect(revoke).not.toBeNull();
  vi.mocked(revokeS3AccessKey).mockResolvedValue();
  vi.mocked(listS3AccessKeys).mockResolvedValue([]);
  await settle(() => revoke?.click());
  expect(revokeS3AccessKey).toHaveBeenCalledWith(existing.id);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Revoked laptop.");
});

it("creates a key, shows the secret once with client examples, and focuses it", async () => {
  vi.mocked(createS3AccessKey).mockResolvedValue({
    accessKey: { ...existing, id: "new", accessKeyId: "HLXBBBBBBBBBBBBBBBBB", label: "nas" },
    secretAccessKey: "s3cr3t-value",
    endpointPath: "/v1/s3",
  });
  await settle(() => root.render(<S3KeysSection />));
  const input = container.querySelector<HTMLInputElement>('input[name="label"]');
  const label = container.querySelector(`label[for="${input?.id ?? ""}"]`);
  expect(label?.textContent).toBe("New key");
  await settle(() => {
    if (input === null) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "nas");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = container.querySelector("form");
  await settle(() => form?.requestSubmit());
  expect(createS3AccessKey).toHaveBeenCalledWith({
    label: "nas",
    scopes: ["drive.read", "drive.write", "drive.delete"],
  });
  const region = container.querySelector('[role="region"][aria-label="New S3 access key"]');
  expect(region?.textContent).toContain("s3cr3t-value");
  expect(document.activeElement).toBe(region);
  const examples = [...container.querySelectorAll("textarea")].map((area) => area.value);
  expect(examples.join("\n")).toContain("--endpoint-url");
  expect(examples.join("\n")).toContain("access_key_id = HLXBBBBBBBBBBBBBBBBB");
});
