import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { helixWebPlugin, rawDesignValues } from "../eslint-rules/design-tokens.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const baseline = JSON.parse(
  readFileSync(new URL("../design-token-baseline.json", import.meta.url)),
);

function lint(source, filename = "src/features/example/new-file.tsx") {
  return new Linter({ cwd: appRoot }).verify(
    source,
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { "helix-web": helixWebPlugin },
      rules: { "helix-web/design-tokens": "error" },
    },
    { filename: `${appRoot}${filename}` },
  );
}

describe("helix-web/design-tokens", () => {
  it("finds raw hex colours and arbitrary font sizes", () => {
    expect(rawDesignValues('style="color:#fff" bg-[#7c3aed80]').map((hit) => hit.value)).toEqual([
      "#fff",
      "#7c3aed80",
    ]);
    expect(
      rawDesignValues(
        "[font-size:13px] text-[11px] text-[0.7rem] text-[length:var(--x)] text-[var(--text-meta)]",
      ).map((hit) => hit.kind),
    ).toEqual(["fontSize", "fontSize", "fontSize", "fontSize", "fontSize"]);
  });

  it("allows tokens, colour utilities, entities, and URL fragments", () => {
    expect(
      rawDesignValues(
        "type-meta text-[var(--text-2)] text-[var(--danger)] [color:var(--star)] &#123; /docs#faq #general",
      ),
    ).toEqual([]);
  });

  it("reports each offence in a file with no baseline", () => {
    const messages = lint(
      'const a = <p className="[font-size:12px] [color:#ff0000]" />; const b = `#abc`;',
    );
    expect(messages.map((message) => message.messageId).sort()).toEqual(["fontSize", "hex", "hex"]);
  });

  it("holds baselined files to their count in both directions", () => {
    const [file, allowed] = Object.entries(baseline)[0];
    const at = (count) => Array.from({ length: count }, () => '"#abcdef"').join(";");
    expect(lint(at(allowed), file)).toEqual([]);
    expect(lint(at(allowed + 1), file).map((m) => m.messageId)).toEqual(["overBaseline"]);
    expect(lint(at(allowed - 1), file).map((m) => m.messageId)).toEqual(["underBaseline"]);
  });

  it("lists only files that exist, with positive counts", () => {
    for (const [file, count] of Object.entries(baseline)) {
      expect(existsSync(`${appRoot}${file}`), file).toBe(true);
      expect(count, file).toBeGreaterThan(0);
    }
  });
});
