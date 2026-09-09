import postgres from "postgres";
import { expect, it } from "vitest";

it.skipIf(process.env.DATABASE_URL === undefined)(
  "removes retired tables and references from live storage triggers",
  async () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
    try {
      const retired = [
        "docs_documents",
        "sheets",
        "slide_decks",
        "drive_preview_jobs",
        "drive_pdf_form_states",
      ];
      for (const table of retired) {
        const rows = await sql`select to_regclass(${`public.${table}`}) as relation`;
        expect(rows[0]?.relation).toBeNull();
      }
      const functions = await sql`select prosrc from pg_proc where proname in (
      'permissions_require_tenant_resource', 'helix_search_reindex_id_page', 'helix_project_sensitivity_assignment'
    )`;
      expect(functions).toHaveLength(3);
      for (const row of functions) {
        for (const table of retired) expect(row.prosrc).not.toContain(table);
      }
    } finally {
      await sql.end();
    }
  },
);
