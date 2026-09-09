#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const branch = process.env.GITHUB_DEFAULT_BRANCH ?? "main";

if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be owner/repository.");
}
if (!token) throw new Error("GITHUB_TOKEN with repository administration permission is required.");
if (!/^[A-Za-z0-9._/-]+$/u.test(branch)) throw new Error("GITHUB_DEFAULT_BRANCH is invalid.");

const policy = JSON.parse(
  await readFile(new URL("../../security/branch-protection.json", import.meta.url), "utf8"),
);
const response = await fetch(
  `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
  {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(policy),
  },
);

if (!response.ok) {
  throw new Error(`GitHub rejected branch protection (${String(response.status)}).`);
}
process.stdout.write(`Applied required security checks to ${repository}:${branch}.\n`);
