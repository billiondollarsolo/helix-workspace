import { createHash } from "node:crypto";
import type { TeamFileFixture } from "./local-team-drive-files.js";
import {
  LOCAL_TEAM_ADMIN,
  LOCAL_TEAM_DIRECT_MESSAGES,
  LOCAL_TEAM_PEOPLE,
  LOCAL_TEAM_ROOMS,
  teamId,
  teamPerson,
} from "./local-team-fixtures.js";

export const VOLUME_MAIL_THREADS_PER_ACTOR = 120;
export const VOLUME_MAIL_MESSAGES_PER_THREAD = 3;
export const VOLUME_FILES_PER_PERSON = 16;
export const VOLUME_ADMIN_FILES = 24;
export const VOLUME_SHARED_FILES = 40;
export const VOLUME_ASSISTANT_PER_PERSON = 16;
export const VOLUME_ADMIN_ASSISTANT = 20;
export const VOLUME_ASSISTANT_MESSAGES = 4;
export const VOLUME_EVENTS_PER_PERSON = 20;
export const VOLUME_ADMIN_EVENTS = 16;
export const VOLUME_ROOM_EXTRA_MESSAGES = 36;
export const VOLUME_DM_MESSAGES = 8;
export const VOLUME_EXISTING_DM_EXTRA = 8;
export const VOLUME_WEEKS_PER_PERSON = 8;

export const ADMIN_FOLDER_ROOT = teamId(1, 400);
export const ADMIN_CALENDAR_ID = teamId(5, 201);

export interface VolumeActor {
  readonly slot: number;
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string;
  readonly firstName: string;
}

export interface VolumeFolder {
  readonly id: string;
  readonly name: string;
  readonly ownerActorId: string;
  readonly parentId: string | null;
  readonly memberActorIds: readonly string[];
  readonly includeAdmin?: boolean;
}

export interface VolumeDirectMessage {
  readonly id: string;
  readonly participantKey: string;
  readonly left: VolumeActor;
  readonly right: VolumeActor;
}

export interface VolumeRoom {
  readonly id: string;
  readonly name: string;
  readonly topic: string;
  readonly memberIndexes: readonly number[];
  readonly includeAdmin: boolean;
}

const SUBJECTS = [
  "Harbor review",
  "Access check",
  "Customer follow-up",
  "Thursday notes",
  "Restore drill",
  "Seat count",
  "Launch copy",
  "Interview quote",
  "On-call handoff",
  "Budget line",
  "Denied-state copy",
  "Pilot FAQ",
  "Northstar rehearsal",
  "Ridgeway invite",
  "Brightline restore",
  "Office hours",
] as const;

const CATEGORIES = [
  "primary",
  "primary",
  "primary",
  "updates",
  "primary",
  "social",
  "primary",
  "promotions",
] as const;

export function volumeActors(withAdmin: boolean): readonly VolumeActor[] {
  const people: VolumeActor[] = LOCAL_TEAM_PEOPLE.map((person) => ({
    slot: person.index,
    actorId: person.actorId,
    email: person.email,
    displayName: person.displayName,
    firstName: person.firstName,
  }));
  if (withAdmin) {
    people.push({
      slot: 10,
      actorId: LOCAL_TEAM_ADMIN.actorId,
      email: LOCAL_TEAM_ADMIN.email,
      displayName: LOCAL_TEAM_ADMIN.displayName,
      firstName: LOCAL_TEAM_ADMIN.firstName,
    });
  }
  return people;
}

export function volumeCounterpart(slot: number, thread: number, size: number): number {
  if (size < 2) throw new Error("Volume mail needs at least two mailboxes.");
  return (slot + 1 + (thread % (size - 1))) % size;
}

export function volumeMailSubject(slot: number, thread: number): string {
  const title = SUBJECTS[thread % SUBJECTS.length] ?? "Harbor note";
  return `${title} ${String(thread + 1).padStart(3, "0")} — ${volumeActors(true)[slot]?.firstName ?? "Harbor"}`;
}

export function volumeMailCategory(thread: number): (typeof CATEGORIES)[number] {
  return CATEGORIES[thread % CATEGORIES.length] ?? "primary";
}

function participantKeyFor(left: string, right: string): string {
  return createHash("sha256").update([left, right].sort().join(",")).digest("hex");
}

export function volumeDirectMessages(withAdmin: boolean): readonly VolumeDirectMessage[] {
  const actors = volumeActors(withAdmin);
  const skip = new Set(LOCAL_TEAM_DIRECT_MESSAGES.map((direct) => direct.participantKey));
  if (withAdmin) {
    skip.add(participantKeyFor(LOCAL_TEAM_ADMIN.actorId, teamPerson(0).actorId));
  }
  const extra: VolumeDirectMessage[] = [];
  let index = 0;
  for (let left = 0; left < actors.length; left += 1) {
    for (let right = left + 1; right < actors.length; right += 1) {
      const a = actors[left];
      const b = actors[right];
      if (!a || !b) continue;
      const key = participantKeyFor(a.actorId, b.actorId);
      if (skip.has(key)) continue;
      extra.push({
        id: teamId(3, 500 + index),
        participantKey: key,
        left: a,
        right: b,
      });
      index += 1;
    }
  }
  return extra;
}

export function volumeDirectMessageKeys(withAdmin: boolean): readonly string[] {
  const keys = LOCAL_TEAM_DIRECT_MESSAGES.map((direct) => direct.participantKey);
  if (withAdmin) keys.push(participantKeyFor(LOCAL_TEAM_ADMIN.actorId, teamPerson(0).actorId));
  return [...keys, ...volumeDirectMessages(withAdmin).map((direct) => direct.participantKey)];
}

export function volumeRooms(): readonly VolumeRoom[] {
  return [
    {
      id: teamId(3, 301),
      name: "Northstar rehearsal",
      topic: "Dry-run the customer onboarding path.",
      memberIndexes: [0, 4, 6, 9],
      includeAdmin: true,
    },
    {
      id: teamId(3, 302),
      name: "Ridgeway onboarding",
      topic: "School staff folder questions.",
      memberIndexes: [4, 6, 9],
      includeAdmin: false,
    },
    {
      id: teamId(3, 303),
      name: "Restore drill",
      topic: "Backup restore and permission matrix.",
      memberIndexes: [1, 3, 5, 8],
      includeAdmin: true,
    },
    {
      id: teamId(3, 304),
      name: "Launch copy review",
      topic: "Plain-language launch note.",
      memberIndexes: [0, 4, 9],
      includeAdmin: false,
    },
    {
      id: teamId(3, 305),
      name: "Access exceptions",
      topic: "Unexpected grants and denied-state copy.",
      memberIndexes: [0, 1, 8],
      includeAdmin: true,
    },
    {
      id: teamId(3, 306),
      name: "Budget working group",
      topic: "Seat counts and vendor hours.",
      memberIndexes: [0, 7, 9],
      includeAdmin: false,
    },
    {
      id: teamId(3, 307),
      name: "Design critiques",
      topic: "Empty states and share dialog labels.",
      memberIndexes: [2, 3, 9],
      includeAdmin: false,
    },
    {
      id: teamId(3, 308),
      name: "On-call standup",
      topic: "Mail delay and restore checks.",
      memberIndexes: [3, 5, 8],
      includeAdmin: false,
    },
    {
      id: teamId(3, 309),
      name: "Pilot FAQ",
      topic: "Customer questions collected this week.",
      memberIndexes: [0, 4, 6, 9],
      includeAdmin: true,
    },
    {
      id: teamId(3, 310),
      name: "Friday demo notes",
      topic: "What we will show and who owns the next step.",
      memberIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      includeAdmin: true,
    },
  ];
}

export function volumeFolderFixtures(withAdmin: boolean): readonly VolumeFolder[] {
  const personal = LOCAL_TEAM_PEOPLE.flatMap((person) => {
    const meetingNotes = teamId(1, 31 + person.index);
    const weeks = Array.from({ length: VOLUME_WEEKS_PER_PERSON }, (_, week) => ({
      id: teamId(1, 500 + person.index * 20 + week),
      name: `Week ${String(week + 1)}`,
      ownerActorId: person.actorId,
      parentId: meetingNotes,
      memberActorIds: [person.actorId],
    }));
    return [
      {
        id: teamId(1, 490 + person.index),
        name: "Shared with me",
        ownerActorId: person.actorId,
        parentId: person.folderId,
        memberActorIds: [person.actorId],
      },
      ...weeks,
    ];
  });
  if (!withAdmin) return personal;
  const admin = LOCAL_TEAM_ADMIN.actorId;
  return [
    ...personal,
    {
      id: ADMIN_FOLDER_ROOT,
      name: "Avery's Harbor projects",
      ownerActorId: admin,
      parentId: null,
      memberActorIds: [admin],
    },
    {
      id: teamId(1, 401),
      name: "Drafts",
      ownerActorId: admin,
      parentId: ADMIN_FOLDER_ROOT,
      memberActorIds: [admin],
    },
    {
      id: teamId(1, 402),
      name: "Archive",
      ownerActorId: admin,
      parentId: ADMIN_FOLDER_ROOT,
      memberActorIds: [admin],
    },
    {
      id: teamId(1, 403),
      name: "Access reviews",
      ownerActorId: admin,
      parentId: ADMIN_FOLDER_ROOT,
      memberActorIds: [admin, teamPerson(0).actorId, teamPerson(8).actorId],
      includeAdmin: true,
    },
  ];
}

export function teamVolumeFileFixtures(withAdmin: boolean): readonly TeamFileFixture[] {
  const personal = LOCAL_TEAM_PEOPLE.flatMap((person) =>
    Array.from({ length: VOLUME_FILES_PER_PERSON }, (_, index) => {
      const weekFolder = teamId(1, 500 + person.index * 20 + (index % VOLUME_WEEKS_PER_PERSON));
      const archive = teamId(1, 21 + person.index);
      const folderId = index % 3 === 0 ? archive : weekFolder;
      return {
        key: `vol-${String(person.index)}-${String(index)}`,
        owner: person,
        folderId,
        name: `${person.firstName} note ${String(index + 1).padStart(2, "0")}.md`,
        mimeType: "text/markdown",
        body: `# ${person.firstName} working note ${String(index + 1)}\n\nOwner: ${person.displayName}\nFocus: ${person.focus}.\nNext step: bring one decision to Thursday review.\n`,
      };
    }),
  );
  const shared = Array.from({ length: VOLUME_SHARED_FILES }, (_, index) => {
    const owner = teamPerson(index % LOCAL_TEAM_PEOPLE.length);
    return {
      key: `vol-shared-${String(index)}`,
      owner,
      folderId: teamId(1, 101),
      name: `Team drop ${String(index + 1).padStart(2, "0")}.md`,
      mimeType: "text/markdown",
      body: `# Team drop ${String(index + 1)}\n\nOwner: ${owner.displayName}\nShared with the Harbor team. Status: ${index % 2 === 0 ? "in progress" : "ready for review"}.\n`,
    };
  });
  if (!withAdmin) return [...personal, ...shared];
  const admin = Array.from({ length: VOLUME_ADMIN_FILES }, (_, index) => ({
    key: `vol-admin-${String(index)}`,
    owner: { actorId: LOCAL_TEAM_ADMIN.actorId } as TeamFileFixture["owner"],
    folderId:
      index % 4 === 0 ? teamId(1, 403) : index % 2 === 0 ? teamId(1, 401) : ADMIN_FOLDER_ROOT,
    name: `Admin note ${String(index + 1).padStart(2, "0")}.md`,
    mimeType: "text/markdown",
    body: `# Admin note ${String(index + 1)}\n\nOwner: ${LOCAL_TEAM_ADMIN.displayName}\nCheck sharing on Harbor team resources and keep personal notes private.\n`,
  }));
  return [...personal, ...shared, ...admin];
}

const BASE_COUNTS = {
  accounts: 10,
  mail_threads: 20,
  mail_messages: 60,
  chat_rooms: 5,
  direct_messages: 10,
  chat_messages: 80,
  assistant_conversations: 30,
  assistant_messages: 120,
  calendar_events: 30,
} as const;

const ADMIN_BASE_EXTRA = {
  mail_threads: 1,
  mail_messages: 2,
  direct_messages: 1,
  chat_messages: 3,
  assistant_conversations: 1,
  assistant_messages: 2,
} as const;

export function teamSeedCounts(input: {
  readonly withAdmin: boolean;
  readonly driveFolders: number;
}): Record<string, number> {
  const actors = input.withAdmin ? 11 : 10;
  const extraDms = volumeDirectMessages(input.withAdmin).length;
  const extraRooms = volumeRooms().length;
  const extraRoomMessages = extraRooms * 12;
  const existingDmExtra =
    VOLUME_EXISTING_DM_EXTRA * (LOCAL_TEAM_DIRECT_MESSAGES.length + (input.withAdmin ? 1 : 0));
  const newDmMessages = extraDms * VOLUME_DM_MESSAGES;
  const existingRoomExtra = LOCAL_TEAM_ROOMS.length * VOLUME_ROOM_EXTRA_MESSAGES;
  const admin = input.withAdmin ? ADMIN_BASE_EXTRA : null;
  return {
    accounts: BASE_COUNTS.accounts,
    mail_threads:
      BASE_COUNTS.mail_threads +
      (admin?.mail_threads ?? 0) +
      actors * VOLUME_MAIL_THREADS_PER_ACTOR,
    mail_messages:
      BASE_COUNTS.mail_messages +
      (admin?.mail_messages ?? 0) +
      actors * VOLUME_MAIL_THREADS_PER_ACTOR * VOLUME_MAIL_MESSAGES_PER_THREAD,
    chat_rooms: BASE_COUNTS.chat_rooms + extraRooms,
    direct_messages: BASE_COUNTS.direct_messages + (admin?.direct_messages ?? 0) + extraDms,
    chat_messages:
      BASE_COUNTS.chat_messages +
      (admin?.chat_messages ?? 0) +
      existingRoomExtra +
      extraRoomMessages +
      existingDmExtra +
      newDmMessages,
    assistant_conversations:
      BASE_COUNTS.assistant_conversations +
      (admin?.assistant_conversations ?? 0) +
      LOCAL_TEAM_PEOPLE.length * VOLUME_ASSISTANT_PER_PERSON +
      (input.withAdmin ? VOLUME_ADMIN_ASSISTANT : 0),
    assistant_messages:
      BASE_COUNTS.assistant_messages +
      (admin?.assistant_messages ?? 0) +
      (LOCAL_TEAM_PEOPLE.length * VOLUME_ASSISTANT_PER_PERSON +
        (input.withAdmin ? VOLUME_ADMIN_ASSISTANT : 0)) *
        VOLUME_ASSISTANT_MESSAGES,
    calendar_events:
      BASE_COUNTS.calendar_events +
      LOCAL_TEAM_PEOPLE.length * VOLUME_EVENTS_PER_PERSON +
      (input.withAdmin ? VOLUME_ADMIN_EVENTS : 0),
    drive_folders: input.driveFolders,
  };
}

export function teamVolumeFileCount(withAdmin: boolean): number {
  return teamVolumeFileFixtures(withAdmin).length;
}

export function teamVolumeFolderCount(withAdmin: boolean): number {
  return volumeFolderFixtures(withAdmin).length;
}
