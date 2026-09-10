import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { configuredProviderFetch } from "./factory.js";

it("requires explicit opt-in before an AI provider can reach a private address", async () => {
  const server = createServer((_request, response) => response.end("local model"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    await expect(configuredProviderFetch(url, {})(url)).rejects.toMatchObject({
      code: "blocked_destination",
    });
    const response = await configuredProviderFetch(url, { HELIX_AI_ALLOW_PRIVATE_NETWORK: "true" })(
      url,
    );
    expect(await response.text()).toBe("local model");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
