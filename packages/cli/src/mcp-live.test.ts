import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./runner.js";
class Capture extends Writable {
  output = "";
  override _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.output += chunk.toString();
    callback();
  }
}
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
describe("Modern MCP stdio subscriptions", () => {
  it("forwards notifications without blocking another request and aborts on EOF", async () => {
    const stdin = new PassThrough(),
      stdout = new Capture(),
      stderr = new Capture();
    let cancelled = false;
    const running = runCli(
      ["mcp", "serve"],
      { HELIX_BASE_URL: "https://helix.test", HELIX_API_KEY: "test" },
      { stdin, stdout, stderr },
      async (_url, init) => {
        if (typeof init.body !== "string") throw new Error("Expected JSON body");
        const request = JSON.parse(init.body) as { method: string; id: string };
        expect(new Headers(init.headers).get("mcp-protocol-version")).toBe("2026-07-28");
        if (request.method === "subscriptions/listen")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: {}, _meta: { "io.modelcontextprotocol/subscriptionId": request.id } } })}\n\n`,
                  ),
                );
                init.signal?.addEventListener(
                  "abort",
                  () => {
                    cancelled = true;
                    controller.close();
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
      },
    );
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "watch",
        method: "subscriptions/listen",
        params: { _meta: meta, notifications: {} },
      }) + "\n",
    );
    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping", params: { _meta: meta } }) +
        "\n",
    );
    await vi.waitFor(() => {
      expect(stdout.output).toContain("subscriptions/acknowledged");
      expect(stdout.output).toContain('"id":"ping"');
    });
    stdin.end();
    expect(await running).toBe(0);
    expect(cancelled).toBe(true);
    expect(stderr.output).toBe("");
  });
  it("preserves protocol errors so the host can negotiate supported revisions", async () => {
    const stdin = new PassThrough(),
      stdout = new Capture(),
      stderr = new Capture();
    stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "bad",
        method: "server/discover",
        params: { _meta: meta },
      }) + "\n",
    );
    await runCli(
      ["mcp", "serve"],
      { HELIX_BASE_URL: "https://helix.test" },
      { stdin, stdout, stderr },
      async () =>
        Response.json(
          {
            jsonrpc: "2.0",
            id: "bad",
            error: {
              code: -32022,
              message: "Unsupported",
              data: { supported: ["2026-07-28"], requested: "2099-01-01" },
            },
          },
          { status: 400 },
        ),
    );
    expect(JSON.parse(stdout.output)).toMatchObject({
      error: { code: -32022, data: { supported: ["2026-07-28"] } },
    });
  });
});
