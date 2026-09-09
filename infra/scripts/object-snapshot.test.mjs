#!/usr/bin/env node
import assert from "node:assert/strict";
import { createBackupManifest } from "./backup-manifest.mjs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./object-snapshot.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "helix-object-snapshot-"));
try {
  const bin = join(root, "bin");
  const output = join(root, "objects");
  const source = join(root, "source");
  const remote = join(root, "remote");
  await Promise.all([mkdir(bin), mkdir(source), mkdir(remote)]);
  await writeFile(join(source, "old"), "before boundary");
  await writeFile(join(source, "new"), "after boundary");
  const aws = join(bin, "aws");
  await writeFile(
    aws,
    `#!/usr/bin/env node
const fs=require('fs'),p=require('path'),a=process.argv.slice(2),root=process.env.MOCK_ROOT;
const command=a[a.indexOf('s3api')+1], value=(name)=>{const i=a.indexOf(name); return i<0 ? undefined : a[i+1]};
if(command==='get-object') {
  const destination=a.at(-1), version=value('--version-id');
  const source=version ? p.join(root,'source',version) : p.join(root,'remote',encodeURIComponent(value('--key')));
  fs.copyFileSync(source,destination); if(process.env.MOCK_CORRUPT_READ && !version) fs.appendFileSync(destination,'corrupt'); process.stdout.write('{}');
} else if(command==='put-object') {
  fs.copyFileSync(value('--body'),p.join(root,'remote',encodeURIComponent(value('--key')))); process.stdout.write('{}');
} else if(command==='list-objects-v2') {
  const Contents=fs.readdirSync(p.join(root,'remote')).map(file=>({Key:decodeURIComponent(file),Size:fs.statSync(p.join(root,'remote',file)).size}));
  process.stdout.write(JSON.stringify({Contents}));
} else process.exit(2);
`,
  );
  await chmod(aws, 0o755);
  const refs = join(root, "refs.json");
  const versions = join(root, "versions.json");
  await writeFile(refs, JSON.stringify([{ key: "drive/file.bin", size: 15, sha256: null }]));
  await writeFile(
    versions,
    JSON.stringify({
      Versions: [
        { Key: "drive/file.bin", VersionId: "new", LastModified: "2026-09-02T12:00:01Z", Size: 14 },
        { Key: "drive/file.bin", VersionId: "old", LastModified: "2026-09-02T11:59:59Z", Size: 15 },
      ],
    }),
  );
  run(
    ["capture", refs, versions, "2026-09-02T12:00:00Z", "source", "http://mock", output],
    bin,
    root,
  );
  const inventory = JSON.parse(await readFile(join(output, "inventory.json"), "utf8"));
  if (inventory.object_count !== 1 || inventory.objects[0]?.version_id !== "old") {
    throw new Error("capture did not select the exact pre-boundary version");
  }
  run(["verify", join(output, "inventory.json")], bin, root);
  run(["restore", join(output, "inventory.json"), "target", "http://mock"], bin, root);
  await writeFile(join(output, inventory.objects[0].file), "tampered");
  mustFail(["verify", join(output, "inventory.json")], bin, root);
  const legacy = join(root, "legacy");
  await mkdir(join(legacy, "consistency"), { recursive: true });
  await mkdir(join(legacy, "objects", "source"), { recursive: true });
  await writeFile(join(legacy, "postgres.dump"), "database");
  await writeFile(join(legacy, "consistency", "database.tsv"), "objects\t2\n");
  await writeFile(join(legacy, "objects", "source", "first"), "first object");
  await writeFile(join(legacy, "objects", "source", "second"), "second object");
  await writeFile(join(legacy, "objects", "source.versions.json"), '{"Versions":[]}');
  await writeFile(join(legacy, "objects", "source.versioning.json"), '{"Status":"Enabled"}');
  const integrityKey = "independent-test-manifest-key-at-least-32-bytes";
  await createBackupManifest(legacy, {
    backupId: "legacy",
    tier: "personal",
    createdAt: "2026-09-02T12:00:00Z",
    databaseCapturedAt: "2026-09-02T12:00:00Z",
    objectsCapturedAt: "2026-09-02T12:00:00Z",
    databaseMode: "logical-dump",
    objectsIncluded: true,
    objectBucket: "source",
    encryption: "none",
    integrityKey,
    integrityKeyRef: "vault://test/manifest",
  });
  const legacyArgs = ["restore-legacy", legacy, "target", "http://mock"];
  const legacyEnv = { HELIX_BACKUP_MANIFEST_HMAC_KEY: integrityKey };
  assert.deepEqual(JSON.parse(run(legacyArgs, bin, root, legacyEnv)), { objectCount: 2 });
  assert.equal(await readFile(join(remote, "second"), "utf8"), "second object");
  mustFail(legacyArgs, bin, root, { ...legacyEnv, MOCK_CORRUPT_READ: "1" });
  await writeFile(join(legacy, "objects", "source", "second"), "tampered");
  mustFail(legacyArgs, bin, root, legacyEnv);
  process.stdout.write("object snapshot tests passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
function run(args, bin, root, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_ROOT: root, ...extraEnv },
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || "object snapshot failed");
  return result.stdout;
}
function mustFail(args, bin, root, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_ROOT: root, ...extraEnv },
  });
  if (result.status === 0) throw new Error("object snapshot unexpectedly accepted corruption");
}
