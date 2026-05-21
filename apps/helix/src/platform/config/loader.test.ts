import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventBus, HelixConfig } from "@helix/sdk-types";
import {
  StaticConfigSource,
  YamlConfigSource,
  loadHelixConfig,
  simpleYamlParser,
  subscribeToConfigHotReload,
} from "./loader.js";

describe("real YAML config parser (P2-4)", () => {
  it("parses nested mappings, sequences, and scalar types", () => {
    const parsed = simpleYamlParser.parse(
      [
        "security:",
        "  tier: enterprise",
        "ai:",
        "  enabled: true",
        "  providers:",
        "    - id: openai",
        "      weight: 3",
        "    - id: local",
        "      weight: 1",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      security: { tier: "enterprise" },
      ai: {
        enabled: true,
        providers: [
          { id: "openai", weight: 3 },
          { id: "local", weight: 1 },
        ],
      },
    });
  });

  it("parses YAML 1.2 constructs the hand-rolled parser mishandled", () => {
    const parsed = simpleYamlParser.parse(
      [
        "platform:",
        "  flow: { a: 1, b: [2, 3] }",
        "  multiline: |",
        "    line one",
        "    line two",
        "  quotedColon: 'value: with colon'",
      ].join("\n"),
    ) as { platform: Record<string, unknown> };
    expect(parsed.platform.flow).toEqual({ a: 1, b: [2, 3] });
    expect(parsed.platform.multiline).toBe("line one\nline two\n");
    expect(parsed.platform.quotedColon).toBe("value: with colon");
  });

  it("normalizes an empty document to an empty object", () => {
    expect(simpleYamlParser.parse("")).toEqual({});
    expect(simpleYamlParser.parse("# only a comment\n")).toEqual({});
  });

  it("rejects malformed YAML rather than silently misparsing", () => {
    expect(() => simpleYamlParser.parse("a:\n  - b\n c: bad-indent")).toThrow();
  });
});

describe("YamlConfigSource with the real parser", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "helix-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a config file end to end through loadHelixConfig", async () => {
    const file = join(dir, "helix.yaml");
    await writeFile(
      file,
      ["security:", "  tier: business", "observability:", "  enabled: true"].join("\n"),
      "utf8",
    );
    const config = await loadHelixConfig([new YamlConfigSource(file)]);
    expect(config.security.tier).toBe("business");
    expect(config.observability).toEqual({ enabled: true });
  });
});

describe("config hot-reload wiring (P2-4)", () => {
  it("re-merges from the configured sources and applies the result on a config-changed event", async () => {
    // Mirrors the server.ts wiring: a hot-reload subscription re-runs
    // loadHelixConfig over a stable source list and hands the result to
    // onReload. The source's tier flips between loads to prove the live value
    // is re-read rather than captured once.
    let tier: "personal" | "enterprise" = "personal";
    const sources = [
      new StaticConfigSource({}),
      {
        load: async () => ({ security: { tier } }),
      },
    ];
    let publishedHandler: (() => Promise<void>) | undefined;
    const events: Pick<EventBus, "subscribe"> = {
      subscribe: async (_subject, handler) => {
        publishedHandler = () => Promise.resolve(handler({} as never));
        return () => undefined;
      },
    };
    const applied: HelixConfig[] = [];

    const unsubscribe = await subscribeToConfigHotReload({
      events: events as EventBus,
      reload: () => loadHelixConfig(sources),
      onReload: (config) => {
        applied.push(config);
      },
    });

    expect(publishedHandler).toBeDefined();
    tier = "enterprise";
    await publishedHandler?.();

    expect(applied).toHaveLength(1);
    expect(applied[0]?.security.tier).toBe("enterprise");
    await Promise.resolve(unsubscribe());
  });
});
