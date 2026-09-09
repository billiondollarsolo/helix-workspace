import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { NatsEventBus } from "../events/nats-event-bus.js";
import { CerbosToolAccessPolicy } from "../permissions/tool-access.js";
import { createClamAvVirusScanner } from "../drive/scanning.js";
import { SpamdScanner } from "../mail/spam.js";
import { MeilisearchSearchEngine } from "../search/meilisearch.js";
import { createMeilisearchHttpClient } from "../search/meilisearch-http.js";

const enabled = process.env.HELIX_REAL_SERVICES_INTEGRATION === "1";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:28433";
const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:28434";
const meiliUrl = process.env.MEILI_HOST ?? "http://127.0.0.1:28436";
const meiliKey = process.env.MEILI_MASTER_KEY ?? "helix_dev_meili_master_key";
const cerbosUrl = process.env.CERBOS_HTTP_URL ?? "http://127.0.0.1:28439";
const clamavHost = process.env.MAIL_CLAMAV_HOST ?? "127.0.0.1";
const clamavPort = Number(process.env.MAIL_CLAMAV_PORT ?? "28460");
const spamdHost = process.env.MAIL_SPAMD_HOST ?? "127.0.0.1";
const spamdPort = Number(process.env.MAIL_SPAMD_PORT ?? "28459");
const resources: Array<() => Promise<void>> = [];

describe.runIf(enabled)("mandatory real-service contracts", () => {
  afterAll(async () => Promise.allSettled(resources.map((close) => close())));

  it("uses Redis and NATS instead of process-local substitutes", async () => {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    resources.push(async () => {
      await redis.quit();
    });
    await redis.connect();
    const key = `helix:integration:${randomUUID()}`;
    await redis.set(key, "shared", "EX", 30);
    await expect(redis.get(key)).resolves.toBe("shared");
    await redis.del(key);

    const bus = await NatsEventBus.connect({ servers: natsUrl }, { subjectPrefix: "integration" });
    resources.push(async () => {
      await bus.close();
    });
    const subject = `roundtrip.${randomUUID().replaceAll("-", "")}`;
    let resolveMessage!: (value: unknown) => void;
    const received = new Promise((resolve) => {
      resolveMessage = resolve;
    });
    const unsubscribe = await bus.subscribe(subject, async (event) => {
      resolveMessage(event.payload);
    });
    resources.push(async () => {
      await unsubscribe();
    });
    await bus.publish(subject, { durable: true });
    await expect(Promise.race([received, timeout(5_000)])).resolves.toEqual({ durable: true });
  });

  it("uses live search, antivirus, and policy allow/deny paths", async () => {
    const documentId = randomUUID();
    const search = new MeilisearchSearchEngine(
      createMeilisearchHttpClient({ baseUrl: meiliUrl, apiKey: meiliKey }),
      { indexUid: `helix_integration_${documentId.replaceAll("-", "")}` },
    );
    await search.ensureIndex();
    await search.index({
      id: documentId,
      type: "drive",
      title: "Real service marker",
      attributes: { orgId: "org-a", allowedActorIds: ["actor-a"] },
    });
    await expect(
      search.search({ query: "Real service marker", filter: 'attributes.orgId = "org-a"' }),
    ).resolves.toMatchObject({ hits: [{ id: documentId }] });
    await expect(
      search.search({ query: "Real service marker", filter: 'attributes.orgId = "org-b"' }),
    ).resolves.toMatchObject({ hits: [] });

    const scanner = createClamAvVirusScanner({ host: clamavHost, port: clamavPort });
    await expect(scanner.scan(Buffer.from("ordinary workspace file"))).resolves.toEqual({
      clean: true,
    });
    await expect(
      scanner.scan(
        Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
      ),
    ).resolves.toMatchObject({ clean: false });
    await expect(
      new SpamdScanner({ host: spamdHost, port: spamdPort, threshold: 5 }).scan(
        "From: sender@example.test\r\nTo: user@example.test\r\nSubject: Contract\r\n\r\nHello",
      ),
    ).resolves.toMatchObject({ evidence: { scanned: true } });

    const policy = new CerbosToolAccessPolicy({ endpoint: cerbosUrl });
    const actor = {
      id: "actor-a",
      orgId: "org-a",
      type: "user" as const,
      scopes: ["drive.read"],
    };
    const resource = {
      type: "tool",
      id: "drive.list",
      orgId: "org-a",
      attributes: { permission: "drive.read", sideEffects: "read" },
    };
    await expect(policy.can(actor, "drive.read", resource)).resolves.toBe(true);
    await expect(policy.can({ ...actor, scopes: [] }, "drive.read", resource)).resolves.toBe(false);
  });
});

function timeout(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("real-service event timed out"));
    }, milliseconds);
    timer.unref();
  });
}
