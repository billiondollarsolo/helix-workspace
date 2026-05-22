/**
 * Seed the 3+-level nested folder tree for the large workspace seed.
 * Folder IDs live in the b100 group.
 */

import {
  ADMIN_ACTOR,
  FOLDER,
  WORKSPACE_SEED_LARGE_SOURCE,
  grantBoth,
  json,
  type SeedSql,
} from "./config.js";

interface FolderDef {
  readonly id: string;
  readonly name: string;
  readonly parent: string | null;
  readonly color: string;
}

const FOLDER_DEFS: readonly FolderDef[] = [
  // Level 0 — root
  { id: FOLDER.root,       name: "Helix Workspace",  parent: null,            color: "blue"   },
  // Level 1 — departments
  { id: FOLDER.engineering, name: "Engineering",     parent: FOLDER.root,     color: "red"    },
  { id: FOLDER.product,     name: "Product",         parent: FOLDER.root,     color: "green"  },
  { id: FOLDER.design,      name: "Design",          parent: FOLDER.root,     color: "orange" },
  { id: FOLDER.finance,     name: "Finance",         parent: FOLDER.root,     color: "teal"   },
  { id: FOLDER.marketing,   name: "Marketing",       parent: FOLDER.root,     color: "yellow" },
  { id: FOLDER.people,      name: "People",          parent: FOLDER.root,     color: "purple" },
  { id: FOLDER.legal,       name: "Legal",           parent: FOLDER.root,     color: "gray"   },
  { id: FOLDER.data,        name: "Data",            parent: FOLDER.root,     color: "cyan"   },
  // Level 2 — sub-folders
  { id: FOLDER.backend,     name: "Backend",         parent: FOLDER.engineering, color: "red"    },
  { id: FOLDER.frontend,    name: "Frontend",        parent: FOLDER.engineering, color: "pink"   },
  { id: FOLDER.infra,       name: "Infrastructure",  parent: FOLDER.engineering, color: "brown"  },
  { id: FOLDER.security,    name: "Security",        parent: FOLDER.engineering, color: "indigo" },
  { id: FOLDER.roadmap,     name: "Roadmap",         parent: FOLDER.product,     color: "green"  },
  { id: FOLDER.research,    name: "Research",        parent: FOLDER.product,     color: "lime"   },
  { id: FOLDER.ux,          name: "UX Research",     parent: FOLDER.design,      color: "orange" },
  { id: FOLDER.brand,       name: "Brand",           parent: FOLDER.design,      color: "amber"  },
  { id: FOLDER.payroll,     name: "Payroll",         parent: FOLDER.finance,     color: "teal"   },
  { id: FOLDER.contracts,   name: "Contracts",       parent: FOLDER.finance,     color: "sage"   },
  { id: FOLDER.campaigns,   name: "Campaigns",       parent: FOLDER.marketing,   color: "yellow" },
  { id: FOLDER.content,     name: "Content",         parent: FOLDER.marketing,   color: "gold"   },
  { id: FOLDER.hiring,      name: "Hiring",          parent: FOLDER.people,      color: "violet" },
  { id: FOLDER.onboarding,  name: "Onboarding",      parent: FOLDER.people,      color: "rose"   },
];

export async function seedFolders(sql: SeedSql, orgId: string): Promise<number> {
  for (const f of FOLDER_DEFS) {
    await sql`
      insert into drive_folders (id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata)
      values (
        ${f.id}, ${orgId}, ${f.name}, ${f.parent},
        ${ADMIN_ACTOR}, ${ADMIN_ACTOR},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, color: f.color })}
      )
      on conflict (id) do update
      set name = excluded.name, metadata = excluded.metadata, updated_at = now()
    `;
    await grantBoth(sql, orgId, "folder", f.id, "owner");
  }
  return FOLDER_DEFS.length;
}
