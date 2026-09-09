import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  createOutboundHttpClient,
  isPublicOutboundAddress,
  type OutboundHttpTransportInput,
  type ResolvedOutboundAddress,
} from "./outbound-http.js";

const publicV4 = { address: "93.184.216.34", family: 4 } as const;

describe("outbound HTTP policy", () => {
  it("requires exact hosts for production HTTP or private-network exceptions", () => {
    expect(() => createOutboundHttpClient({ production: true, allowHttp: true })).toThrow(
      "exact host allowlist",
    );
    expect(() => createOutboundHttpClient({ production: true, allowPrivateNetwork: true })).toThrow(
      "exact host allowlist",
    );
  });

  it.each([
    "http://93.184.216.34",
    "https://127.0.0.1",
    "https://2130706433",
    "https://127.1",
    "https://0177.0.0.1",
    "https://0177.1",
    "https://0x7f000001",
    "https://0x7f.1",
    "https://%31%32%37.0.0.1",
    "https://10.0.0.1",
    "https://100.64.0.1",
    "https://169.254.169.254/latest/meta-data",
    "https://172.16.0.1",
    "https://192.168.0.1",
    "https://[::1]",
    "https://[fe80::1]",
    "https://[fc00::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:169.254.169.254]",
    "https://user:secret@public.example/path",
    "file:///etc/passwd",
    "https://metadata.google.internal/computeMetadata/v1",
    "https://METADATA.GOOGLE.INTERNAL./computeMetadata/v1",
    "https://instance-data.ec2.internal/latest/meta-data",
  ])("blocks non-public destination %s", async (url) => {
    const transport = vi.fn(async () => new Response("unexpected"));
    const client = createOutboundHttpClient({
      production: true,
      resolve: async () => [publicV4],
      transport,
    });

    await expect(client(url)).rejects.toMatchObject({ code: "blocked_destination" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects DNS answers containing any private address", async () => {
    const transport = vi.fn(async () => new Response("unexpected"));
    const client = createOutboundHttpClient({
      production: true,
      resolve: async () => [publicV4, { address: "10.0.0.7", family: 4 }],
      transport,
    });

    await expect(client("https://mixed.example")).rejects.toMatchObject({
      code: "blocked_destination",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("pins the validated address so DNS rebinding cannot change the connection", async () => {
    const resolve = vi
      .fn<(hostname: string) => Promise<readonly ResolvedOutboundAddress[]>>()
      .mockResolvedValueOnce([publicV4])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const transport = vi.fn(async (input: OutboundHttpTransportInput) => {
      expect(input.originalUrl.hostname).toBe("hooks.example");
      expect(input.url.hostname).toBe(publicV4.address);
      expect(input.init.headers.get("host")).toBe("hooks.example");
      return new Response("ok");
    });
    const client = createOutboundHttpClient({ production: true, resolve, transport });

    await expect((await client("https://hooks.example/path")).text()).resolves.toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("connects the real transport to the validated address without resolving the hostname again", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.host).toMatch(/^rebind\.example:/u);
      response.end("pinned");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const resolve = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
      const client = createOutboundHttpClient({
        production: true,
        allowHttp: true,
        allowPrivateNetwork: true,
        allowedHosts: ["rebind.example"],
        resolve,
      });

      const response = await client(`http://rebind.example:${String(address.port)}/`);
      await expect(response.text()).resolves.toBe("pinned");
      expect(resolve).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it("revalidates redirects and blocks a redirect to metadata", async () => {
    const transport = vi.fn(async () =>
      Response.redirect("https://169.254.169.254/latest/meta-data", 302),
    );
    const client = createOutboundHttpClient({
      production: true,
      resolve: async () => [publicV4],
      transport,
    });

    await expect(client("https://hooks.example/start")).rejects.toMatchObject({
      code: "blocked_destination",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("resolves every safe redirect hop and strips credentials across origins", async () => {
    const addresses = new Map<string, ResolvedOutboundAddress>([
      ["one.example", { address: "93.184.216.34", family: 4 }],
      ["two.example", { address: "1.1.1.1", family: 4 }],
    ] as const);
    const resolve = vi.fn(async (hostname: string) => {
      const address = addresses.get(hostname);
      if (address === undefined) throw new Error("unknown test host");
      return [address];
    });
    const transport = vi.fn(async (input: OutboundHttpTransportInput) => {
      if (input.originalUrl.hostname === "one.example") {
        return Response.redirect("https://two.example/final", 302);
      }
      expect(input.init.headers.has("authorization")).toBe(false);
      expect(input.init.headers.has("cookie")).toBe(false);
      expect(input.init.headers.has("x-tenant-secret")).toBe(false);
      return Response.json({ ok: true });
    });
    const client = createOutboundHttpClient({ production: true, resolve, transport });

    const response = await client("https://one.example/start", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-tenant-secret": "secret",
      },
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(resolve.mock.calls.map(([hostname]) => hostname)).toEqual([
      "one.example",
      "two.example",
    ]);
  });

  it("never follows redirects for requests with a body", async () => {
    const transport = vi.fn(async () => Response.redirect("https://two.example/final", 307));
    const client = createOutboundHttpClient({
      production: true,
      resolve: async () => [publicV4],
      transport,
    });

    const response = await client("https://one.example/start", {
      method: "POST",
      body: "secret payload",
    });
    expect(response.status).toBe(307);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("blocks redirects that downgrade HTTPS", async () => {
    const transport = vi.fn(async () => Response.redirect("http://public.example/final", 302));
    const client = createOutboundHttpClient({
      production: true,
      resolve: async () => [publicV4],
      transport,
    });

    await expect(client("https://one.example/start")).rejects.toMatchObject({
      code: "blocked_destination",
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("enforces request and response byte limits", async () => {
    const transport = vi.fn(async () => new Response("123456"));
    const client = createOutboundHttpClient({
      production: true,
      maxRequestBytes: 5,
      maxResponseBytes: 5,
      resolve: async () => [publicV4],
      transport,
    });

    await expect(
      client("https://hooks.example", { method: "POST", body: "123456" }),
    ).rejects.toMatchObject({ code: "request_too_large" });
    await expect((await client("https://hooks.example")).text()).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("rejects an oversized declared response before reading it", async () => {
    const client = createOutboundHttpClient({
      production: true,
      maxResponseBytes: 5,
      resolve: async () => [publicV4],
      transport: async () => new Response("x", { headers: { "content-length": "6" } }),
    });

    await expect(client("https://hooks.example")).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("enforces a total deadline even when the transport ignores abort", async () => {
    const client = createOutboundHttpClient({
      production: true,
      timeoutMs: 5,
      resolve: async () => [publicV4],
      transport: async () => new Promise<Response>(() => undefined),
    });

    await expect(client("https://hooks.example")).rejects.toMatchObject({ code: "aborted" });
  });

  it("applies the total deadline while reading a streaming request body", async () => {
    const transport = vi.fn(async () => new Response("unexpected"));
    const client = createOutboundHttpClient({
      production: true,
      timeoutMs: 5,
      resolve: async () => [publicV4],
      transport,
    });
    const body = new ReadableStream<Uint8Array>({
      pull: async () => new Promise<void>(() => undefined),
    });

    await expect(client("https://hooks.example", { method: "POST", body })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("applies the total deadline while streaming a response body", async () => {
    const client = createOutboundHttpClient({
      production: true,
      timeoutMs: 5,
      resolve: async () => [publicV4],
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: async () => new Promise<void>(() => undefined),
          }),
        ),
    });

    const response = await client("https://hooks.example");
    await expect(response.text()).rejects.toMatchObject({ code: "aborted" });
  });

  it("redacts query credentials and transport errors", async () => {
    const client = createOutboundHttpClient({
      production: true,
      resolve: async () => [publicV4],
      transport: async () => {
        throw new Error("transport leaked super-secret");
      },
    });

    const error = await client("https://hooks.example/path?token=super-secret").catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "transport_failed" });
    expect(String(error)).toBe(
      "OutboundHttpError: Outbound HTTP request failed (transport_failed) for https://hooks.example.",
    );
  });

  it("pins an explicitly configured egress proxy", async () => {
    const transport = vi.fn(async (input: OutboundHttpTransportInput) => {
      expect(input.proxyUrl?.hostname).toBe("10.0.0.9");
      expect(input.proxyServername).toBe("egress.internal");
      return new Response("ok");
    });
    const client = createOutboundHttpClient({
      production: true,
      proxyUrl: "http://egress.internal:3128",
      resolve: async (hostname) =>
        hostname === "egress.internal" ? [{ address: "10.0.0.9", family: 4 }] : [publicV4],
      transport,
    });

    await expect((await client("https://hooks.example")).text()).resolves.toBe("ok");
  });
});

describe("public address classification", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
  ])("classifies %s as non-public", (address) => {
    expect(isPublicOutboundAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "classifies %s as public",
    (address) => {
      expect(isPublicOutboundAddress(address)).toBe(true);
    },
  );
});
