/**
 * Cross-app trash/restore sync registry (G5/G7).
 * Drive no longer hardcodes docs/sheets/slides table SQL — editors register handlers.
 */

export interface TrashSyncSql {
  // Minimal surface: template-tag style executor (postgres.js compatible).
  (strings: TemplateStringsArray, ...values: unknown[]): unknown;
}

export interface TrashSyncInput {
  readonly sql: TrashSyncSql;
  readonly orgId: string;
  readonly objectId: string;
  readonly deletedAt: Date | null;
}

export type TrashSyncHandler = (input: TrashSyncInput) => Promise<void>;

export interface TrashSyncRegistry {
  run(app: string | null | undefined, input: TrashSyncInput): Promise<void>;
  has(app: string): boolean;
}

export function createTrashSyncRegistry(
  handlers: Readonly<Record<string, TrashSyncHandler>> = {},
): TrashSyncRegistry {
  const map = new Map(Object.entries(handlers));
  return {
    has(app: string): boolean {
      return map.has(app);
    },
    async run(app, input): Promise<void> {
      if (app === null || app === undefined || app.length === 0) return;
      const handler = map.get(app);
      if (handler === undefined) return;
      await handler(input);
    },
  };
}

/** Default editor handlers that mirror the historical hardcoded switch. */
export function createDefaultEditorTrashSyncHandlers(): Record<string, TrashSyncHandler> {
  return {
    docs: async ({ sql, orgId, objectId, deletedAt }) => {
      await sql`
        update docs_documents set deleted_at = ${deletedAt}, updated_at = now()
        where id = ${objectId} and org_id = ${orgId}
      `;
    },
    sheets: async ({ sql, orgId, objectId, deletedAt }) => {
      await sql`
        update sheets set deleted_at = ${deletedAt}, updated_at = now()
        where id = ${objectId} and org_id = ${orgId}
      `;
    },
    slides: async ({ sql, orgId, objectId, deletedAt }) => {
      await sql`
        update slide_decks set deleted_at = ${deletedAt}, updated_at = now()
        where id = ${objectId} and org_id = ${orgId}
      `;
    },
  };
}

export function createDefaultTrashSyncRegistry(): TrashSyncRegistry {
  return createTrashSyncRegistry(createDefaultEditorTrashSyncHandlers());
}
