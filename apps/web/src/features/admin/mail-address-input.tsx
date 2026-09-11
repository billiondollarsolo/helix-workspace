import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminField, AdminInput, AdminSelect } from "./console/controls";
import { Button } from "@/components/ui/button";
import type { MailAddresses } from "@/lib/mail-addresses";
import { groupMailDomainsQueryOptions } from "./groups-api";

/** Choose a verified mail namespace; the server still validates ownership and collisions. */
export function MailAddressInput({
  label,
  value,
  purpose,
  onChange,
  required = true,
  domains: suppliedDomains,
}: {
  readonly label: string;
  readonly value: string;
  readonly purpose: "primary" | "alias" | "group";
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly domains?: MailAddresses["eligibleDomains"];
}) {
  const queryClient = useQueryClient();
  const domains = useQuery({
    ...groupMailDomainsQueryOptions(),
    enabled: suppliedDomains === undefined,
  });
  const eligible = (suppliedDomains ?? domains.data?.eligibleDomains ?? []).filter((domain) =>
    purpose === "primary" ? domain.primary : domain.aliases,
  );
  const at = value.lastIndexOf("@");
  const local = at < 0 ? value : value.slice(0, at);
  const selected = at < 0 ? "" : value.slice(at + 1);
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <AdminField label={`${label} name`}>
          <AdminInput
            aria-label={`${label} name`}
            required={required}
            value={local}
            pattern={"[^@\\s]+"}
            placeholder="name"
            onChange={(event) => onChange(`${event.target.value}${selected ? `@${selected}` : ""}`)}
          />
        </AdminField>
        <AdminField label={`${label} domain`}>
          <AdminSelect
            aria-label={`${label} domain`}
            required={required || local.length > 0}
            value={selected}
            disabled={suppliedDomains === undefined && (domains.isPending || domains.isError)}
            onChange={(event) => onChange(`${local}@${event.target.value}`)}
          >
            <option value="">
              {suppliedDomains === undefined && domains.isPending
                ? "Loading domains…"
                : "Select a verified domain"}
            </option>
            {selected && !eligible.some((domain) => domain.domain === selected) ? (
              <option value={selected} disabled>
                {selected} (unavailable)
              </option>
            ) : null}
            {eligible.map((domain) => (
              <option key={domain.domain} value={domain.domain}>
                {domain.domain}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </div>
      {suppliedDomains === undefined && domains.isError ? (
        <p role="alert" className="text-sm">
          {domains.error.message}{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void queryClient.invalidateQueries({
                queryKey: groupMailDomainsQueryOptions().queryKey,
              });
            }}
          >
            Retry domains
          </Button>
        </p>
      ) : null}
      {(suppliedDomains !== undefined || (!domains.isPending && !domains.isError)) &&
      eligible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No verified domains support this address. Enable the required mail{" "}
          {purpose === "primary" ? "and identity" : "and alias"} capabilities in Admin → Domains.
        </p>
      ) : null}
    </div>
  );
}
