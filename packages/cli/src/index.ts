#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runCli } from "./runner.js";

export { buildHelixRequest, buildMcpRequest } from "./client.js";
export { parseCliArgs } from "./parser.js";
export { CLI_TOOL_IDS } from "./tool-ids.js";
export type { HelixCliEnv, HelixRequest } from "./client.js";
export type { JsonArgument } from "./json-input.js";
export type { HelixCommand } from "./parser.js";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli(process.argv.slice(2), process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  }).then((code) => {
    process.exitCode = code;
  });
}
