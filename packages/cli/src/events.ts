import { open as openFile, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watchLiveEvents } from "@helix/sdk/live";
import type { CliContext } from "./runner.js";
import { CliUsageError } from "./cli-error.js";

export interface EventsWatchCommand {
  readonly kind: "events-watch";
  readonly cursorFile: string;
  readonly handler?: string;
  readonly all: boolean;
  readonly after?: number;
}
export function parseEventsWatch(args: readonly string[]): EventsWatchCommand {
  let cursorFile: string | undefined,
    handler: string | undefined,
    all = false;
  let after: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--after") {
      const value = args[++i] ?? "";
      after = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(after))
        throw new CliUsageError("--after requires a nonnegative safe integer.");
      continue;
    }
    if (key === "--all") {
      all = true;
      continue;
    }
    if (
      (key !== "--cursor-file" && key !== "--handler") ||
      !args[i + 1] ||
      args[i + 1]?.startsWith("--")
    )
      throw new CliUsageError(
        "Usage: helix events watch --cursor-file <path> [--handler <executable>] [--all]",
      );
    if (key === "--cursor-file") cursorFile = args[++i];
    else handler = args[++i];
  }
  if (!cursorFile)
    throw new CliUsageError("events watch requires --cursor-file so a restart can resume safely.");
  return {
    kind: "events-watch",
    cursorFile,
    ...(handler ? { handler } : {}),
    ...(after === undefined ? {} : { after }),
    all,
  };
}
export async function runEventsWatch(
  command: EventsWatchCommand,
  context: CliContext,
): Promise<number> {
  const baseUrl = context.env.HELIX_BASE_URL,
    token = context.env.HELIX_API_KEY || context.env.HELIX_ACCESS_TOKEN;
  if (!baseUrl || !token)
    throw new CliUsageError("Set HELIX_BASE_URL and a scoped HELIX_API_KEY or HELIX_ACCESS_TOKEN.");
  const file = resolve(command.cursorFile),
    lock = `${file}.lock`,
    temporary = `${file}.${String(process.pid)}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await openFile(lock, "wx", 0o600).catch(() => {
    throw new Error(
      "Cursor is locked. Stop the other listener; remove the .lock file only if its process has exited.",
    );
  });
  const controller = new AbortController(),
    stop = () => {
      controller.abort();
    };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // A checkpoint cannot silently cross identities after credentials or hosts change.
  const binding = createHash("sha256").update(`${baseUrl}\n${token}`).digest("hex");
  try {
    await handle.writeFile(String(process.pid));
    let after = command.after ?? 0;
    try {
      const saved: unknown = JSON.parse(await readFile(file, "utf8"));
      if (command.after !== undefined)
        throw new Error(
          "--after requires a new cursor file; existing checkpoints must not be silently replaced.",
        );
      if (
        typeof saved !== "object" ||
        saved === null ||
        !("binding" in saved) ||
        saved.binding !== binding ||
        !("cursor" in saved) ||
        typeof saved.cursor !== "number" ||
        !Number.isSafeInteger(saved.cursor) ||
        saved.cursor < 0
      )
        throw new Error(
          "Checkpoint identity or cursor is invalid. Resynchronize into a new cursor file.",
        );
      after = saved.cursor;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const selected = new Set([
      "chat.direct",
      "chat.mentioned",
      "approval.updated",
      "approval.requested",
    ]);
    for await (const page of watchLiveEvents({
      baseUrl,
      token,
      after,
      signal: controller.signal,
    })) {
      for (const event of page.events) {
        if (!command.all && !selected.has(event.type)) continue;
        if (command.handler) {
          const executable = resolve(command.handler);
          await new Promise<void>((done, reject) => {
            const child = spawn(executable, [], {
              stdio: ["pipe", "inherit", "inherit"],
              shell: false,
              signal: controller.signal,
              env: { ...process.env, HELIX_EVENT_ID: event.id },
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code === 0) done();
              else
                reject(
                  new Error(`Event handler failed (${String(code)}); checkpoint was not advanced.`),
                );
            });
            child.stdin.on("error", () => {
              reject(new Error("Event handler closed its input; checkpoint was not advanced."));
            });
            child.stdin.end(JSON.stringify(event) + "\n");
          });
        } else {
          await new Promise<void>((done, reject) =>
            context.io.stdout.write(JSON.stringify(event) + "\n", (error) => {
              if (error) reject(error);
              else done();
            }),
          );
        }
      }
      const output = await openFile(temporary, "wx", 0o600);
      try {
        await output.writeFile(JSON.stringify({ binding, cursor: page.cursor }) + "\n");
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, file);
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await handle.close();
    await unlink(lock);
    await unlink(temporary).catch(() => undefined);
  }
}
