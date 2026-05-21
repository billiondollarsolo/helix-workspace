import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advisoryLockKey,
  LeaderElection,
  SingletonWorkerSupervisor,
  type AdvisoryLockClient,
  type SupervisedWorker,
} from "./election.js";

/**
 * In-memory advisory-lock client modelling Postgres semantics: a given lock
 * key may be held by exactly one holder at a time. A holder is identified by
 * its own client instance, so multiple clients sharing one `held` set behave
 * like multiple replicas contending for the same Postgres lock.
 */
class FakeAdvisoryLockClient implements AdvisoryLockClient {
  private readonly owned = new Set<bigint>();

  constructor(private readonly held: Set<bigint> = new Set()) {}

  async tryAdvisoryLock(lockKey: bigint): Promise<boolean> {
    if (this.held.has(lockKey)) {
      return false;
    }
    this.held.add(lockKey);
    this.owned.add(lockKey);
    return true;
  }

  async releaseAdvisoryLock(lockKey: bigint): Promise<void> {
    if (this.owned.has(lockKey)) {
      this.owned.delete(lockKey);
      this.held.delete(lockKey);
    }
  }
}

class FakeWorker implements SupervisedWorker {
  starts = 0;
  stops = 0;

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }
}

describe("advisoryLockKey", () => {
  it("derives a stable 64-bit key for a given name", () => {
    expect(advisoryLockKey("outbox-worker")).toBe(advisoryLockKey("outbox-worker"));
  });

  it("derives different keys for different names", () => {
    expect(advisoryLockKey("outbox-worker")).not.toBe(advisoryLockKey("mail-worker"));
  });
});

describe("LeaderElection", () => {
  it("grants the lease to the first caller and denies the second", async () => {
    const held = new Set<bigint>();
    const electionA = new LeaderElection(new FakeAdvisoryLockClient(held));
    const electionB = new LeaderElection(new FakeAdvisoryLockClient(held));

    const leaseA = await electionA.tryAcquire("outbox-worker");
    const leaseB = await electionB.tryAcquire("outbox-worker");

    expect(leaseA.acquired).toBe(true);
    expect(leaseB.acquired).toBe(false);
  });

  it("allows a second caller to acquire after the first releases", async () => {
    const held = new Set<bigint>();
    const electionA = new LeaderElection(new FakeAdvisoryLockClient(held));
    const electionB = new LeaderElection(new FakeAdvisoryLockClient(held));

    const leaseA = await electionA.tryAcquire("outbox-worker");
    await leaseA.release();
    const leaseB = await electionB.tryAcquire("outbox-worker");

    expect(leaseB.acquired).toBe(true);
  });

  it("releases at most once even when called repeatedly", async () => {
    const client = new FakeAdvisoryLockClient();
    const releaseSpy = vi.spyOn(client, "releaseAdvisoryLock");
    const election = new LeaderElection(client);

    const lease = await election.tryAcquire("worker");
    await lease.release();
    await lease.release();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("does not release a lock it never acquired", async () => {
    const held = new Set<bigint>();
    const electionA = new LeaderElection(new FakeAdvisoryLockClient(held));
    const electionB = new LeaderElection(new FakeAdvisoryLockClient(held));

    await electionA.tryAcquire("worker");
    const leaseB = await electionB.tryAcquire("worker");
    await leaseB.release();

    // Releasing the un-acquired lease must not free A's lock.
    const electionC = new LeaderElection(new FakeAdvisoryLockClient(held));
    expect((await electionC.tryAcquire("worker")).acquired).toBe(false);
  });
});

describe("SingletonWorkerSupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the worker on the replica that wins leadership", async () => {
    const worker = new FakeWorker();
    const supervisor = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker,
      election: new LeaderElection(new FakeAdvisoryLockClient()),
    });

    await supervisor.start();

    expect(worker.starts).toBe(1);
    expect(supervisor.isLeader).toBe(true);
    await supervisor.stop();
  });

  it("does not start the worker on a replica that loses leadership", async () => {
    const held = new Set<bigint>();
    const worker = new FakeWorker();
    const leader = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker: new FakeWorker(),
      election: new LeaderElection(new FakeAdvisoryLockClient(held)),
    });
    await leader.start();

    const follower = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker,
      election: new LeaderElection(new FakeAdvisoryLockClient(held)),
      retryIntervalMs: 0,
    });
    await follower.start();

    expect(worker.starts).toBe(0);
    expect(follower.isLeader).toBe(false);
    await leader.stop();
    await follower.stop();
  });

  it("stops the worker and releases the lease on stop", async () => {
    const held = new Set<bigint>();
    const worker = new FakeWorker();
    const supervisor = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker,
      election: new LeaderElection(new FakeAdvisoryLockClient(held)),
    });

    await supervisor.start();
    await supervisor.stop();

    expect(worker.stops).toBe(1);

    // The lease is freed, so a new replica can become leader.
    const next = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker: new FakeWorker(),
      election: new LeaderElection(new FakeAdvisoryLockClient(held)),
    });
    await next.start();
    expect(next.isLeader).toBe(true);
    await next.stop();
  });

  it("a follower takes over after the leader releases its lease", async () => {
    vi.useFakeTimers();
    const held = new Set<bigint>();
    const leader = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker: new FakeWorker(),
      election: new LeaderElection(new FakeAdvisoryLockClient(held)),
    });
    await leader.start();

    const followerWorker = new FakeWorker();
    const follower = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker: followerWorker,
      election: new LeaderElection(new FakeAdvisoryLockClient(held)),
      retryIntervalMs: 1_000,
    });
    await follower.start();
    expect(followerWorker.starts).toBe(0);

    // Leader goes away; follower's retry timer should claim leadership.
    await leader.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(followerWorker.starts).toBe(1);
    expect(follower.isLeader).toBe(true);
    await follower.stop();
  });

  it("is idempotent across repeated start/stop calls", async () => {
    const worker = new FakeWorker();
    const supervisor = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker,
      election: new LeaderElection(new FakeAdvisoryLockClient()),
    });

    await supervisor.start();
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();

    expect(worker.starts).toBe(1);
    expect(worker.stops).toBe(1);
  });

  it("retries acquisition after an election error", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    let failNext = true;
    const flakyClient: AdvisoryLockClient = {
      tryAdvisoryLock: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("connection reset");
        }
        return true;
      },
      releaseAdvisoryLock: async () => undefined,
    };
    const errors: unknown[] = [];
    const supervisor = new SingletonWorkerSupervisor({
      name: "outbox-worker",
      worker,
      election: new LeaderElection(flakyClient),
      retryIntervalMs: 500,
      onError: (error) => errors.push(error),
    });

    await supervisor.start();
    expect(worker.starts).toBe(0);
    expect(errors).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(worker.starts).toBe(1);
    await supervisor.stop();
  });
});
