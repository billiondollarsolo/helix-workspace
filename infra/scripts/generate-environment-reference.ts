import { readFileSync, writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { fileURLToPath } from "node:url";
import { envSchema } from "../../apps/helix/src/config/env.js";

const destination = new URL("../../docs/reference/environment.md", import.meta.url);
const rows = Object.entries(envSchema.shape)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, schema]) => {
    const result = schema.safeParse(undefined);
    const defaultValue: unknown = result.success ? result.data : undefined;
    const sensitive = /SECRET|PASSWORD|PASS$|TOKEN|KEY/.test(name);
    const value =
      defaultValue === undefined
        ? "—"
        : sensitive
          ? "Set explicitly in production"
          : `\`${String(defaultValue).replaceAll("|", "\\|")}\``;
    return `| \`${name}\` | ${result.success ? "Optional" : "Required"} | ${value} |`;
  });
const document = await format(
  `# Environment reference\n\nGenerated from the validated environment schema; run \`pnpm quality:environment:write\` after changing configuration.\n\nProduction assertions impose additional requirements; follow the [deployment guide](../deployment.md). Secrets can use the supported \`*_FILE\` variables documented there.\n\n| Variable | Schema input | Default |\n| --- | --- | --- |\n${rows.join("\n")}\n`,
  { ...(await resolveConfig(fileURLToPath(destination))), parser: "markdown" },
);
if (process.argv.includes("--write")) writeFileSync(destination, document);
else if (readFileSync(destination, "utf8") !== document)
  throw new Error("Environment reference is stale. Run pnpm quality:environment:write.");
