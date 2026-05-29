import { eq } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

export type OrgScopedPgTable = AnyPgTable & {
  readonly orgId: AnyPgColumn;
};

export interface TenantScopedSelectBuilder<TTable extends OrgScopedPgTable> {
  from(table: TTable): TenantScopedWhereBuilder;
}

export interface TenantScopedInsertBuilder {
  values(values: Record<string, unknown> | readonly Record<string, unknown>[]): unknown;
}

export interface TenantScopedUpdateBuilder {
  set(values: Record<string, unknown>): TenantScopedWhereBuilder;
}

export interface TenantScopedWhereBuilder {
  where(predicate: unknown): unknown;
}

export interface TenantScopedDrizzleDatabase {
  select(fields?: Record<string, unknown>): TenantScopedSelectBuilder<OrgScopedPgTable>;
  insert(table: OrgScopedPgTable): TenantScopedInsertBuilder;
  update(table: OrgScopedPgTable): TenantScopedUpdateBuilder;
  delete(table: OrgScopedPgTable): TenantScopedWhereBuilder;
}

export type TenantScopedInsertValues = Record<string, unknown> | readonly Record<string, unknown>[];

export interface TenantScopedQueryBuilder<TTable extends OrgScopedPgTable> {
  select(fields?: Record<string, unknown>): unknown;
  insert(values: TenantScopedInsertValues): unknown;
  update(values: Record<string, unknown>): unknown;
  delete(): unknown;
  raw<T>(query: (db: TenantScopedDrizzleDatabase, table: TTable, orgId: string) => T): T;
}

export function tenantScoped<TTable extends OrgScopedPgTable>(
  db: TenantScopedDrizzleDatabase,
  table: TTable,
  orgId: string,
): TenantScopedQueryBuilder<TTable> {
  return {
    select(fields) {
      return db.select(fields).from(table).where(eq(table.orgId, orgId));
    },
    insert(values) {
      if (isInsertValueArray(values)) {
        return db.insert(table).values(values.map((value) => withOrgId(value, orgId)));
      }

      return db.insert(table).values(withOrgId(values, orgId));
    },
    update(values) {
      return db.update(table).set(values).where(eq(table.orgId, orgId));
    },
    delete() {
      return db.delete(table).where(eq(table.orgId, orgId));
    },
    raw(query) {
      return query(db, table, orgId);
    },
  };
}

function withOrgId(value: Record<string, unknown>, orgId: string): Record<string, unknown> {
  return { ...value, orgId };
}

function isInsertValueArray(
  value: TenantScopedInsertValues,
): value is readonly Record<string, unknown>[] {
  return Array.isArray(value);
}
