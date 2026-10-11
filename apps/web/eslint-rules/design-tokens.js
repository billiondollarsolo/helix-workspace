import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

/* helix-web/design-tokens — colours and type sizes come from tokens.
 *
 * Rejects raw hex colours ("#7c3aed", "[color:#fff]") and arbitrary font
 * sizes ("[font-size:13px]", "text-[11px]", "text-[length:…]",
 * "text-[var(--text-meta)]") in string and template literals. Use a token
 * (`var(--label-violet)`, `var(--star)`, …) or a `type-*` utility instead.
 *
 * Files that predate the rule are listed in design-token-baseline.json with
 * their current count. The count may only shrink: more offences fail, and
 * fewer fail too until the baseline is lowered, so the allowlist ratchets
 * down like the file-size baseline. */

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const HEX_COLOR = /(?<![\w&/#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/giu;
const ARBITRARY_FONT_SIZE =
  /\[font-size:|\btext-\[(?:length:|[\d.]+(?:px|rem|em)\]|var\(--text-(?:display|h\d|body|meta|caption|chip|overline|\d{2}))/gu;

/** Raw design values in one string. */
export function rawDesignValues(text) {
  return [
    ...[...text.matchAll(HEX_COLOR)].map((match) => ({ kind: "hex", value: match[0] })),
    ...[...text.matchAll(ARBITRARY_FONT_SIZE)].map((match) => ({
      kind: "fontSize",
      value: match[0],
    })),
  ];
}

function loadBaseline() {
  return JSON.parse(
    readFileSync(new URL("../design-token-baseline.json", import.meta.url), "utf8"),
  );
}

const designTokensRule = {
  meta: {
    type: "problem",
    docs: { description: "Require design tokens for colours and font sizes." },
    messages: {
      hex: "Raw colour {{value}}: use a colour token such as var(--label-*), var(--star), or var(--accent).",
      fontSize:
        "Arbitrary font size {{value}}: use a type-* utility (type-body, type-meta, type-caption, …).",
      overBaseline:
        "{{count}} raw colours or font sizes; design-token-baseline.json allows {{allowed}} here and may only shrink.",
      underBaseline:
        "Only {{count}} raw colours or font sizes remain; lower this file's entry in design-token-baseline.json to {{count}}.",
    },
    schema: [],
  },
  create(context) {
    const file = relative(appRoot, context.filename).split(sep).join("/");
    const allowed = loadBaseline()[file] ?? 0;
    const hits = [];
    const collect = (node, text) => {
      for (const hit of rawDesignValues(text)) hits.push({ node, ...hit });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") collect(node, node.value);
      },
      TemplateElement(node) {
        collect(node, node.value.raw);
      },
      "Program:exit"(program) {
        if (allowed === 0) {
          for (const hit of hits) {
            context.report({ node: hit.node, messageId: hit.kind, data: { value: hit.value } });
          }
        } else if (hits.length > allowed) {
          context.report({
            node: program,
            messageId: "overBaseline",
            data: { count: String(hits.length), allowed: String(allowed) },
          });
        } else if (hits.length < allowed) {
          context.report({
            node: program,
            messageId: "underBaseline",
            data: { count: String(hits.length) },
          });
        }
      },
    };
  },
};

export const helixWebPlugin = { rules: { "design-tokens": designTokensRule } };
