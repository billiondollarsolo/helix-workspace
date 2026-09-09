export interface DriveHardDeleteState {
  readonly trashedAt: Date | null;
  readonly trashExpiresAt: Date | null;
  readonly legalHold: boolean;
  readonly activeShareCount: number;
  readonly pendingJobCount: number;
}

export function driveHardDeleteBlockers(state: DriveHardDeleteState, now: Date): readonly string[] {
  const blockers: string[] = [];
  if (state.trashedAt === null) blockers.push("not_trashed");
  if (state.trashExpiresAt === null || state.trashExpiresAt > now) blockers.push("retention");
  if (state.legalHold) blockers.push("legal_hold");
  if (state.activeShareCount > 0) blockers.push("active_shares");
  if (state.pendingJobCount > 0) blockers.push("pending_jobs");
  return blockers;
}

export interface DriveOrphanCandidate {
  readonly id: string;
  readonly orgId: string;
  readonly storageKey: string;
  readonly kind: "blob" | "multipart";
  readonly uploadId?: string;
}

export interface DriveOrphanRepository {
  listCandidates(input: {
    readonly olderThan: Date;
    readonly limit: number;
  }): Promise<readonly DriveOrphanCandidate[]>;
  markCollected(candidate: DriveOrphanCandidate): Promise<void>;
}

export interface DriveOrphanStorage {
  delete(orgId: string, storageKey: string): Promise<void>;
  abortMultipart(orgId: string, storageKey: string, uploadId: string): Promise<void>;
}

export async function collectDriveOrphans(input: {
  readonly repository: DriveOrphanRepository;
  readonly storage: DriveOrphanStorage;
  readonly olderThan: Date;
  readonly limit?: number;
  readonly dryRun: boolean;
}): Promise<{ readonly candidates: number; readonly collected: number }> {
  const candidates = await input.repository.listCandidates({
    olderThan: input.olderThan,
    limit: Math.min(Math.max(input.limit ?? 100, 1), 1_000),
  });
  if (input.dryRun) {
    return { candidates: candidates.length, collected: 0 };
  }
  let collected = 0;
  for (const candidate of candidates) {
    if (candidate.kind === "multipart") {
      if (candidate.uploadId === undefined) {
        continue;
      }
      await input.storage.abortMultipart(candidate.orgId, candidate.storageKey, candidate.uploadId);
    } else {
      await input.storage.delete(candidate.orgId, candidate.storageKey);
    }
    await input.repository.markCollected(candidate);
    collected += 1;
  }
  return { candidates: candidates.length, collected };
}
