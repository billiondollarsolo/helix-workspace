import type postgres from "postgres";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { OutboundMailQueueStore } from "./store-contracts.js";

/** Bounded, round-robin tenant discovery; queue rows remain protected by RLS. */
export function tenantMailClaims(
  sql: postgres.Sql,
  store: Pick<OutboundMailQueueStore, "claimDueOutbound">,
): Pick<OutboundMailQueueStore, "claimDueOutbound"> {
  let afterId: string | null = null;
  return {
    async claimDueOutbound(input) {
      const startAfterId = afterId;
      let remaining = 100;
      for (const wrapping of [false, true]) {
        if (wrapping) {
          if (startAfterId === null || remaining === 0) break;
          afterId = null;
        }
        const orgs = await sql<{ readonly id: string }[]>`
          select id from orgs
          where status = 'active' and (${afterId}::uuid is null or id > ${afterId}::uuid)
            and (${wrapping ? startAfterId : null}::uuid is null or id <= ${startAfterId}::uuid)
          order by id limit ${remaining}
        `;
        for (const org of orgs) {
          afterId = org.id;
          const claimed = await withTenantPostgresContext(sql, { orgId: org.id }, () =>
            store.claimDueOutbound(input),
          );
          if (claimed !== null) return claimed;
        }
        if (orgs.length < remaining) afterId = null;
        remaining -= orgs.length;
      }
      return null;
    },
  };
}
