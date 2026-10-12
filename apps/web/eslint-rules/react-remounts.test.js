import { RuleTester } from "eslint";
import { describe } from "vitest";
import { remountRules } from "./react-remounts.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    parserOptions: { ecmaFeatures: { jsx: true } },
    sourceType: "module",
  },
});

describe("helix-web/no-nested-components", () => {
  // RuleTester registers its own cases through the global describe/it.
  ruleTester.run("no-nested-components", remountRules["no-nested-components"], {
    valid: [
      // Module scope: one stable type.
      "function Row() { return <input />; } export function List() { return <Row />; }",
      // Called as a function, so it contributes elements, not a type.
      "export function List() { const renderRow = () => <input />; return <div>{renderRow()}</div>; }",
      // Picking a module-level component is fine.
      "const Icons = { A: () => <svg /> }; export function List({ k }) { const Icon = Icons[k]; return <Icon />; }",
      // Lowercase helpers are not component types.
      "export function List() { function row() { return <input />; } return <div>{row()}</div>; }",
      // A nested factory that returns no JSX is not a component.
      "export function List() { function Thing() { return null; } return <Thing />; }",
    ],
    invalid: [
      {
        code: "export function Form() { function Field() { return <input />; } return <Field />; }",
        errors: [{ messageId: "nested" }],
      },
      {
        code: "export const Form = () => { const Field = () => <input />; return <div><Field /><Field /></div>; };",
        errors: [{ messageId: "nested" }],
      },
      {
        code: "export function Form() { const Field = memo(() => <input />); return <Field />; }",
        errors: [{ messageId: "nested" }],
      },
      {
        code: "export function Form({ rows }) { return rows.map((row) => { const Cell = () => <input value={row.v} />; return <Cell key={row.id} />; }); }",
        errors: [{ messageId: "nested" }],
      },
    ],
  });
});

describe("helix-web/no-editable-key", () => {
  ruleTester.run("no-editable-key", remountRules["no-editable-key"], {
    valid: [
      // Stable client key; the editable id is not part of it.
      "rows.map((row, i) => <input key={row.rowKey} value={row.id} onChange={(e) => update(i, { id: e.target.value })} />);",
      // The key prop is not what the handler edits.
      "rows.map((row) => <input key={row.id} value={row.name} onChange={(e) => update(row.id, { name: e.target.value })} />);",
      // Forwarding the identity is not a write.
      "rows.map((row) => <Toggle key={row.id} onCheckedChange={(on) => save({ id: row.id, enabled: on })} />);",
      // No edit handler in the row.
      "rows.map((row) => <li key={row.name}>{row.name}</li>);",
      // Handler passed by reference is not followed (documented trade-off).
      "rows.map((row) => <input key={row.name} onChange={handleChange} />);",
      // A nested map's key belongs to the nested callback.
      "rows.map((row) => <select key={row.id} onChange={(e) => update(row.id, { model: e.target.value })}>{row.models.map((model) => <option key={model}>{model}</option>)}</select>);",
    ],
    invalid: [
      {
        code: "providers.map((provider, index) => <article key={`${provider.id}-${String(index)}`}><input value={provider.id} onChange={(e) => update(index, { id: e.target.value })} /></article>);",
        errors: [{ messageId: "editableKey", data: { prop: "id" } }],
      },
      {
        code: "rows.map((row) => <input key={row.email} onChange={(e) => { row.email = e.target.value; }} />);",
        errors: [{ messageId: "editableKey", data: { prop: "email" } }],
      },
      {
        code: "rows.map((row, i) => <Field key={row.label} onValueChange={(v) => setField(i, 'label', v)} />);",
        errors: [{ messageId: "editableKey", data: { prop: "label" } }],
      },
      {
        code: "rows.map(({ name, value }, i) => <input key={name} value={value} onInput={(e) => patch(i, { name: e.target.value })} />);",
        errors: [{ messageId: "editableKey", data: { prop: "name" } }],
      },
    ],
  });
});
