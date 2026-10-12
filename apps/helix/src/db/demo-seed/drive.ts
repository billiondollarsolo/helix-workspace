import { createHash } from "node:crypto";
import { activePeople, DEPARTMENTS, type DepartmentKey, type Person } from "./company.js";
import { mapLimit } from "./concurrency.js";
import type { Directory } from "./directory.js";
import {
  companyFiles,
  dataExport,
  DEPARTMENT_FOLDERS,
  departmentFile,
  personalFile,
  type GeneratedFile,
} from "./drive-content.js";
import { SeedRandom, TIME } from "./random.js";
import { DemoSeedError, type DemoRuntime } from "./runtime.js";

interface SeededFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** The uploader. */
  readonly ownerId: string;
  /** Who holds owner rights: the uploader in My Drive, the drive's creator in a shared drive. */
  readonly managerId: string;
  readonly scope: "personal" | "department" | "company";
  readonly department: DepartmentKey | null;
  readonly createdAt: Date;
  readonly byteSize: number;
}

export interface DriveSeed {
  readonly files: readonly SeededFile[];
  readonly folders: number;
  readonly versions: number;
  readonly comments: number;
  readonly shareLinks: number;
  readonly trashed: number;
  readonly bytes: number;
}

const COMMENTS = [
  "Can we add the depot list to the appendix?",
  "Numbers look right to me. Approving.",
  "Small typo in the second paragraph.",
  "Who owns the follow-up here?",
  "Let's discuss this in Thursday's sync.",
  "I updated the totals — please double-check the March row.",
  "Is this still current after the pricing change?",
  "+1, this matches what we heard from customers.",
];

/**
 * Drive goes through the same staged path as a browser upload: prepare (quota
 * reservation and ACL), bytes written to the tenant-prefixed key, then finalize
 * (size and hash verification, ClamAV scan, blob commit, storage accounting).
 */
export async function seedDrive(runtime: DemoRuntime, directory: Directory): Promise<DriveSeed> {
  const people = activePeople(directory.people);
  const lead = (department: DepartmentKey) =>
    people.find((person) => person.department === department && person.managerKey === "person-0") ??
    people.find((person) => person.department === department);
  const random = SeedRandom.stream("drive");
  const files: SeededFile[] = [];
  let folders = 0;
  let bytes = 0;

  const folder = async (owner: Person, name: string, parent: string | null, createdAt: Date) => {
    const entry = await runtime.drive.createFolder({
      orgId: runtime.orgId,
      actorId: owner.actorId,
      name,
      parentFolderId: parent,
      metadata: { color: random.pick(["blue", "green", "orange", "purple", "gray"]) },
    });
    folders += 1;
    runtime.chronology.at(
      "drive_folders",
      { id: entry.id },
      { created_at: createdAt, updated_at: createdAt },
    );
    return entry.id;
  };
  const upload = async (
    owner: Person,
    file: GeneratedFile,
    folderId: string | null,
    createdAt: Date,
    department: DepartmentKey | null,
    manager: Person = owner,
  ) => {
    const seeded = await uploadFile(runtime, owner.actorId, file, folderId);
    bytes += file.body.length;
    runtime.chronology.at(
      "objects",
      { id: seeded },
      { created_at: createdAt, updated_at: createdAt },
    );
    const record: SeededFile = {
      id: seeded,
      name: file.name,
      mimeType: file.mimeType,
      ownerId: owner.actorId,
      managerId: manager.actorId,
      scope: folderId === null ? "personal" : department === null ? "company" : "department",
      department,
      createdAt,
      byteSize: file.body.length,
    };
    files.push(record);
    return record;
  };

  await runtime.drive.setLifecyclePolicy({
    orgId: runtime.orgId,
    actorId: directory.people.find((person) => person.login === "admin")?.actorId ?? "",
    trashRetentionDays: 30,
    orphanGraceHours: 24,
  });

  // Company shared drive, readable by everyone and maintained by People.
  const peopleLead = lead("people");
  if (peopleLead === undefined) throw new DemoSeedError("The roster has no People lead.");
  const companyRoot = await folder(peopleLead, "Company", null, runtime.timeline.start);
  await runtime.driveWorkflows.create({
    orgId: runtime.orgId,
    actorId: peopleLead.actorId,
    kind: "shared_drive",
    resourceType: "folder",
    resourceId: companyRoot,
    payload: { name: "Company" },
  });
  await runtime.drive.share({
    orgId: runtime.orgId,
    actorId: peopleLead.actorId,
    objectId: companyRoot,
    targetActorIds: people
      .filter((person) => person.actorId !== peopleLead.actorId)
      .map((person) => person.actorId),
    role: "reader",
  });
  const companyFolders = new Map<string, string>();
  for (const name of ["Policies", "Benefits", "Brand", "All-hands"]) {
    companyFolders.set(name, await folder(peopleLead, name, companyRoot, runtime.timeline.start));
  }
  for (const file of companyFiles(runtime.timeline.now.getUTCFullYear())) {
    const when = runtime.timeline.recentWorkday(random);
    await upload(peopleLead, file, companyFolders.get(file.folder) ?? companyRoot, when, null);
  }

  // One shared drive per department with its working folders.
  const departmentFolders = new Map<DepartmentKey, readonly { name: string; id: string }[]>();
  for (const department of DEPARTMENTS) {
    const owner = lead(department.key);
    if (owner === undefined) continue;
    const members = people.filter(
      (person) => person.department === department.key && person.actorId !== owner.actorId,
    );
    const root = await folder(
      owner,
      department.name,
      null,
      runtime.timeline.daysAgo(runtime.timeline.historyDays - 4),
    );
    await runtime.driveWorkflows.create({
      orgId: runtime.orgId,
      actorId: owner.actorId,
      kind: "shared_drive",
      resourceType: "folder",
      resourceId: root,
      payload: { name: department.name },
    });
    if (members.length > 0) {
      await runtime.drive.share({
        orgId: runtime.orgId,
        actorId: owner.actorId,
        objectId: root,
        targetActorIds: members.map((person) => person.actorId),
        role: "editor",
      });
    }
    const children: { name: string; id: string }[] = [];
    for (const name of DEPARTMENT_FOLDERS[department.key]) {
      children.push({
        name,
        id: await folder(
          owner,
          name,
          root,
          runtime.timeline.daysAgo(runtime.timeline.historyDays - 10),
        ),
      });
    }
    departmentFolders.set(department.key, children);
  }

  // Department documents written by the people in each department.
  const perPerson = runtime.preset.driveFilesPerPerson;
  await mapLimit(people, 6, async (person) => {
    const personRandom = SeedRandom.stream("drive-person", person.key);
    const sinceJoined = Math.min(person.tenureDays, runtime.timeline.historyDays);
    for (let index = 0; index < perPerson; index += 1) {
      const when = runtime.timeline.recentWorkday(personRandom, sinceJoined);
      const children = departmentFolders.get(person.department) ?? [];
      if ((index + person.index) % 3 === 0 || children.length === 0) {
        await upload(person, personalFile(person, when, personRandom), null, when, null);
      } else {
        const target = personRandom.pick(children);
        await upload(
          person,
          departmentFile(person.department, target.name, person, when, personRandom),
          target.id,
          when,
          person.department,
          lead(person.department) ?? person,
        );
      }
    }
  });

  // Bulky monthly exports from the Data team, so storage usage is not all tiny documents.
  const engineeringLead = lead("engineering");
  const exportFolder = departmentFolders.get("engineering")?.[0];
  const analyst = people.find((person) => person.team === "Data") ?? engineeringLead;
  if (engineeringLead !== undefined && exportFolder !== undefined && analyst !== undefined) {
    const exportRandom = SeedRandom.stream("drive-exports");
    const months = { small: 1, medium: 3, large: 6 }[runtime.size];
    for (let index = 0; index < months; index += 1) {
      const start = new Date(
        Date.UTC(
          runtime.timeline.now.getUTCFullYear(),
          runtime.timeline.now.getUTCMonth() - index - 1,
          2,
          14,
        ),
      );
      const month = start.toISOString().slice(0, 7);
      for (const file of dataExport(month, 2 + (index % 3), exportRandom)) {
        await upload(analyst, file, exportFolder.id, start, "engineering", engineeringLead);
      }
    }
  }

  // Concurrent uploads finish in any order; later passes draw randomness per file.
  files.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.name.localeCompare(b.name) ||
      a.ownerId.localeCompare(b.ownerId),
  );
  const versions = await seedVersions(runtime, directory, files, random);
  const comments = await seedComments(runtime, directory, files, random);
  await seedStars(runtime, people, files, random);
  const shareLinks = await seedSharing(runtime, directory, files, random);
  const trashed = await seedTrash(runtime, files, random);
  return { files, folders, versions, comments, shareLinks, trashed, bytes };
}

async function uploadFile(
  runtime: DemoRuntime,
  actorId: string,
  file: GeneratedFile,
  folderId: string | null,
): Promise<string> {
  const sha256 = createHash("sha256").update(file.body).digest("hex");
  const prepared = await runtime.drive.prepareUpload({
    orgId: runtime.orgId,
    actorId,
    name: file.name,
    folderId,
    mimeType: file.mimeType,
    byteSize: file.body.length,
    sha256,
  });
  // The browser PUTs to the presigned URL for this key; the tenant client writes the same key.
  const storage = await runtime.storageResolver({ orgId: runtime.orgId });
  if (storage === undefined) throw new DemoSeedError("Tenant object storage is unavailable.");
  await storage.client.put({
    key: prepared.storageKey,
    body: file.body,
    contentType: file.mimeType,
  });
  const version = await runtime.drive.finalizeUpload({
    orgId: runtime.orgId,
    actorId,
    objectId: prepared.objectId,
    byteSize: file.body.length,
    sha256,
    mimeType: file.mimeType,
    idempotencyKey: `demo-seed:${prepared.objectId}:1`,
  });
  if (version.objectId !== prepared.objectId) {
    throw new DemoSeedError(`Drive finalize returned a different object for ${file.name}.`);
  }
  return prepared.objectId;
}

/** Re-saves a share of text documents, so they carry a version history. */
async function seedVersions(
  runtime: DemoRuntime,
  directory: Directory,
  files: readonly SeededFile[],
  random: SeedRandom,
): Promise<number> {
  let versions = 0;
  const editable = files.filter(
    (file) => file.mimeType === "text/markdown" || file.mimeType === "text/csv",
  );
  for (const file of editable.filter(() => random.chance(0.22))) {
    const saves = random.int(1, 3);
    const storage = await runtime.storageResolver({ orgId: runtime.orgId });
    const current = await storage?.client.get(await currentKey(runtime, file.id));
    if (current === null || current === undefined) continue;
    let body = Buffer.from(current.body as Uint8Array);
    let savedAt = file.createdAt;
    for (let save = 0; save < saves; save += 1) {
      const editor = editorFor(directory, file, random);
      savedAt = new Date(
        Math.min(
          savedAt.getTime() + random.int(1, 30) * TIME.DAY,
          runtime.timeline.now.getTime() - TIME.HOUR,
        ),
      );
      body = Buffer.concat([
        body,
        Buffer.from(
          file.mimeType === "text/csv"
            ? `${random.pick(["Adjusted", "Forecast", "Actual"])},${String(random.int(10, 900))},${editor.displayName},updated\n`
            : `\n_Updated by ${editor.displayName}: ${random.pick(["clarified the rollout plan", "added the open questions", "fixed the numbers", "linked the follow-up ticket"])}._\n`,
        ),
      ]);
      await runtime.drive.finalizeUpload({
        orgId: runtime.orgId,
        actorId: editor.actorId,
        objectId: file.id,
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        mimeType: file.mimeType,
        content: body,
        idempotencyKey: `demo-seed:${file.id}:${String(save + 2)}`,
      });
      versions += 1;
    }
    runtime.chronology.at(
      "objects",
      { id: file.id },
      { created_at: file.createdAt, updated_at: savedAt },
    );
  }
  return versions;
}

async function currentKey(runtime: DemoRuntime, objectId: string): Promise<string> {
  const rows = await runtime.tenant(
    (tx) =>
      tx<
        { readonly storage_key: string }[]
      >`select storage_key from objects where id = ${objectId}`,
  );
  const key = rows[0]?.storage_key;
  if (key === undefined) throw new DemoSeedError(`Drive object ${objectId} disappeared.`);
  return key;
}

function editorFor(directory: Directory, file: SeededFile, random: SeedRandom): Person {
  const candidates = activePeople(directory.people).filter(
    (person) => file.department !== null && person.department === file.department,
  );
  const owner = directory.people.find((person) => person.actorId === file.ownerId);
  if (candidates.length > 0) return random.pick(candidates);
  if (owner === undefined) throw new DemoSeedError(`Drive file ${file.name} has no owner.`);
  return owner;
}

async function seedComments(
  runtime: DemoRuntime,
  directory: Directory,
  files: readonly SeededFile[],
  random: SeedRandom,
): Promise<number> {
  let count = 0;
  for (const file of files.filter((entry) => entry.scope !== "personal" && random.chance(0.16))) {
    const author = editorFor(directory, file, random);
    const root = await runtime.drive.createComment({
      orgId: runtime.orgId,
      actorId: author.actorId,
      objectId: file.id,
      body: random.pick(COMMENTS),
    });
    count += 1;
    if (random.chance(0.6)) {
      await runtime.drive.createComment({
        orgId: runtime.orgId,
        actorId: file.ownerId,
        objectId: file.id,
        parentCommentId: root.id,
        body: random.pick([
          "Done, thanks!",
          "Good catch — fixed.",
          "Let's keep it as is for now.",
          "Added in the latest version.",
        ]),
      });
      count += 1;
      if (random.chance(0.6)) {
        await runtime.drive.resolveComment({
          orgId: runtime.orgId,
          actorId: file.ownerId,
          commentId: root.id,
        });
      }
    }
  }
  return count;
}

async function seedStars(
  runtime: DemoRuntime,
  people: readonly Person[],
  files: readonly SeededFile[],
  random: SeedRandom,
): Promise<void> {
  for (const person of people) {
    const mine = files.filter(
      (file) =>
        file.ownerId === person.actorId ||
        (file.department !== null && file.department === person.department),
    );
    for (const file of random.sample(mine, random.int(1, 4))) {
      await runtime.drive.setStarred({
        orgId: runtime.orgId,
        actorId: person.actorId,
        objectId: file.id,
        starred: true,
      });
    }
  }
}

/** Personal files shared with teammates, plus a few public links. */
async function seedSharing(
  runtime: DemoRuntime,
  directory: Directory,
  files: readonly SeededFile[],
  random: SeedRandom,
): Promise<number> {
  const people = activePeople(directory.people);
  for (const file of files.filter((entry) => entry.scope === "personal" && random.chance(0.35))) {
    const owner = people.find((person) => person.actorId === file.ownerId);
    if (owner === undefined) continue;
    const targets = random.sample(
      people.filter(
        (person) =>
          person.actorId !== owner.actorId &&
          (person.department === owner.department || random.chance(0.1)),
      ),
      random.int(1, 3),
    );
    if (targets.length === 0) continue;
    await runtime.drive.share({
      orgId: runtime.orgId,
      actorId: owner.actorId,
      objectId: file.id,
      targetActorIds: targets.map((person) => person.actorId),
      role: random.chance(0.4) ? "editor" : "reader",
    });
  }
  let links = 0;
  const publishable = files.filter(
    (file) =>
      file.mimeType === "application/pdf" &&
      /Benefits|handbook|Proposal|Release|Brand/u.test(file.name),
  );
  for (const file of publishable.slice(0, 6)) {
    await runtime.drive.createShareLink({
      orgId: runtime.orgId,
      actorId: file.managerId,
      objectId: file.id,
      expiresAt: links % 2 === 0 ? new Date(runtime.timeline.now.getTime() + 60 * TIME.DAY) : null,
      allowDownload: true,
    });
    links += 1;
  }
  return links;
}

/** A few personal files sit in Trash, inside the 30-day retention window. */
async function seedTrash(
  runtime: DemoRuntime,
  files: readonly SeededFile[],
  random: SeedRandom,
): Promise<number> {
  let trashed = 0;
  const personal = files.filter((entry) => entry.scope === "personal");
  const count = Math.max(3, Math.round(personal.length * 0.06));
  for (const file of random.sample(personal, Math.min(count, personal.length))) {
    await runtime.drive.trash({ orgId: runtime.orgId, actorId: file.ownerId, objectId: file.id });
    const deletedAt = runtime.timeline.daysAgo(random.int(1, 26), random.int(13, 21));
    runtime.chronology.at(
      "objects",
      { id: file.id },
      { created_at: file.createdAt, updated_at: deletedAt, deleted_at: deletedAt },
    );
    trashed += 1;
  }
  return trashed;
}
