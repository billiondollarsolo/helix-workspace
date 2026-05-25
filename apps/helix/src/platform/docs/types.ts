import type { AIClassification, JsonObject } from "@helix/sdk-types";

export const docsPluginId = "com.helix.core.docs";

export const docsExportFormats = ["markdown", "pdf", "docx", "epub"] as const;
export type DocsExportFormat = (typeof docsExportFormats)[number];

export interface DocsExportFormatDescriptor {
  readonly format: DocsExportFormat;
  readonly extension: string;
  readonly mimeType: string;
  readonly binary: boolean;
}

export const docsExportFormatDescriptors = {
  markdown: {
    format: "markdown",
    extension: "markdown",
    mimeType: "text/markdown; charset=utf-8",
    binary: false,
  },
  pdf: {
    format: "pdf",
    extension: "pdf",
    mimeType: "application/pdf",
    binary: true,
  },
  docx: {
    format: "docx",
    extension: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    binary: true,
  },
  epub: {
    format: "epub",
    extension: "epub",
    mimeType: "application/epub+zip",
    binary: true,
  },
} as const satisfies Record<DocsExportFormat, DocsExportFormatDescriptor>;
export type DocsTimestamp = Date | string;
export const docsEditorEngines = [
  "legacy-yjs",
  "onlyoffice-ooxml",
  "helix-native-document",
] as const;
export type DocsEditorEngine = (typeof docsEditorEngines)[number];

export type DocsActivityPayload = JsonObject & {
  readonly id?: string | undefined;
  readonly docId?: string | undefined;
  readonly documentId?: string | undefined;
};

export type DocsActor = JsonObject & {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
};

export type DocsOutlineItem = JsonObject & {
  readonly id: string;
  readonly level: number;
  readonly title: string;
  readonly anchor: string;
  readonly summary?: string | undefined;
};

export type DocsCommentProjection = JsonObject & {
  readonly id: string;
  readonly parentCommentId?: string | null | undefined;
  readonly body: string;
  readonly anchor?: JsonObject | string | undefined;
  readonly author?: DocsActor | undefined;
  readonly createdAt?: DocsTimestamp | undefined;
};

export interface DocsDocumentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly threadId: string | null;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly ydocState: Buffer | null;
  readonly ydocStateVector: Buffer | null;
  readonly updateSeq: number;
  readonly editorEngine: string;
  readonly formatVersion: number;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocsUpdateRecord {
  readonly id: string;
  readonly orgId: string;
  readonly documentId: string;
  readonly actorId?: string | null | undefined;
  readonly seq: number;
  readonly update: Buffer;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
}

export type DocsVersionPreviewCompleteness = "snapshot" | "reconstructed";

export interface DocsVersionDiffLine {
  readonly kind: "unchanged" | "added" | "removed";
  readonly text: string;
}

export interface DocsVersionPreviewRecord {
  readonly version: DocsUpdateRecord;
  readonly documentId: string;
  readonly currentUpdateSeq: number;
  readonly currentText: string;
  readonly versionText: string;
  readonly completeness: DocsVersionPreviewCompleteness;
  readonly complete: boolean;
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly diff: readonly DocsVersionDiffLine[];
  readonly warnings: readonly string[];
}

export interface DocsVersionRestoreRecord {
  readonly document: DocsDocumentRecord;
  readonly restoredVersion: DocsUpdateRecord;
  readonly restoreVersion: DocsUpdateRecord;
}

export interface DocsCommentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly documentId: string;
  readonly parentCommentId: string | null;
  readonly actorId: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type DocsCommentListItem = DocsCommentRecord & {
  readonly author?: DocsActor | undefined;
};

export const docsSuggestionStatuses = ["pending", "accepted", "rejected"] as const;
export type DocsSuggestionStatus = (typeof docsSuggestionStatuses)[number];
export type DocsAskSourceScope = "document" | "selection";

/**
 * A tracked-change / proposed edit on a document. Distinct from {@link DocsCommentRecord}:
 * a suggestion proposes replacing `beforeText` with `afterText` and can be accepted
 * (applied to the document) or rejected.
 */
export interface DocsSuggestionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly documentId: string;
  readonly actorId: string | null;
  readonly anchor: JsonObject;
  readonly beforeText: string;
  readonly afterText: string;
  readonly reason: string;
  readonly status: DocsSuggestionStatus;
  readonly metadata: JsonObject;
  readonly resolvedByActorId: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocsAskHistoryRecord {
  readonly id: string;
  readonly orgId: string;
  readonly documentId: string;
  readonly actorId: string;
  readonly question: string;
  readonly answer: string;
  readonly sourceScope: DocsAskSourceScope;
  readonly sourceExcerpt: string;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocsExportDocument {
  readonly id: string;
  readonly orgId?: string | undefined;
  readonly title: string;
  readonly markdown?: string | undefined;
  readonly plainText?: string | undefined;
  readonly html?: string | undefined;
  readonly outline?: readonly DocsOutlineItem[] | undefined;
  readonly comments?: readonly DocsCommentProjection[] | undefined;
  readonly updatedAt?: DocsTimestamp | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface DocsExportResult {
  readonly docId: string;
  readonly format: DocsExportFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly text?: string | undefined;
  readonly metadata: JsonObject;
}

export interface DocsExportRecord {
  readonly documentId: string;
  readonly title: string;
  readonly format: DocsExportFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly contentBase64: string;
  readonly exportedAt: Date;
}

export interface DocsExportStore {
  getDocsExportDocument?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
  }): Promise<DocsExportDocument | null>;
}

export interface DocsSearchRecord extends DocsExportDocument {
  readonly orgId: string;
  readonly owner?: DocsActor | undefined;
  readonly collaborators?: readonly DocsActor[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly classification?: AIClassification | undefined;
  readonly createdAt: DocsTimestamp;
  readonly updatedAt?: DocsTimestamp | undefined;
  readonly archivedAt?: DocsTimestamp | undefined;
  readonly deletedAt?: DocsTimestamp | undefined;
}

export interface DocsSearchProjectionStore {
  getDocsSearchRecord(docId: string): Promise<DocsSearchRecord | null>;
}

export interface DocsOutlineEnrichmentRecord {
  readonly id: string;
  readonly title: string;
  readonly markdown?: string | undefined;
  readonly plainText?: string | undefined;
  readonly html?: string | undefined;
  readonly body?: string | undefined;
  readonly outline?: readonly DocsOutlineItem[] | undefined;
  readonly classification?: AIClassification | undefined;
  readonly deletedAt?: DocsTimestamp | undefined;
}

export interface DocsOutlineEnrichmentStore {
  getDocsOutlineEnrichmentRecord(docId: string): Promise<DocsOutlineEnrichmentRecord | null>;
  recordDocsOutlineEnrichment?(input: {
    readonly docId: string;
    readonly outline: readonly DocsOutlineItem[];
    readonly summary?: string | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<void>;
}
