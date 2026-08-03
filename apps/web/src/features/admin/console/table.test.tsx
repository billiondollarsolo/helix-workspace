// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminTable, type AdminColumn } from "./table";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Person {
  readonly id: string;
  readonly name: string;
  readonly seats: number;
  readonly email: string | null;
}

const PEOPLE: readonly Person[] = [
  { id: "b", name: "Bea", seats: 2, email: "bea@helix.test" },
  { id: "a", name: "Ada", seats: 10, email: null },
  { id: "c", name: "Cy", seats: 1, email: "cy@helix.test" },
];

const COLUMNS: readonly AdminColumn<Person>[] = [
  { id: "name", header: "Name", cell: (row) => row.name, sortValue: (row) => row.name },
  {
    id: "seats",
    header: "Seats",
    align: "right",
    cell: (row) => String(row.seats),
    sortValue: (row) => row.seats,
  },
  {
    id: "email",
    header: "Email",
    cell: (row) => row.email ?? "—",
    sortValue: (row) => row.email,
  },
  { id: "actions", header: "Actions", headerHidden: true, cell: () => "…" },
];

describe("AdminTable", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(rows: readonly Person[], props: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        createElement(AdminTable<Person>, {
          label: "People",
          columns: COLUMNS,
          rows,
          rowKey: (row: Person) => row.id,
          ...props,
        }),
      );
    });
  }

  function names(): readonly string[] {
    return [...container.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("td")?.textContent ?? "",
    );
  }

  function header(name: string): HTMLTableCellElement {
    const match = [...container.querySelectorAll("th")].find((cell) =>
      cell.textContent?.includes(name),
    );
    if (!(match instanceof HTMLTableCellElement)) {
      throw new Error(`Header not found: ${name}`);
    }
    return match;
  }

  function clickHeader(name: string) {
    const button = header(name).querySelector("button");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("leaves the caller's order alone until a column is sorted", () => {
    render(PEOPLE);

    // The server's order is information — newest-first for a directory or a
    // log — so an unsorted table must not quietly impose one of its own.
    expect(names()).toEqual(["Bea", "Ada", "Cy"]);
    expect(header("Name").getAttribute("aria-sort")).toBe("none");
  });

  it("cycles none, ascending, descending, none", () => {
    render(PEOPLE);

    clickHeader("Name");
    expect(names()).toEqual(["Ada", "Bea", "Cy"]);
    expect(header("Name").getAttribute("aria-sort")).toBe("ascending");

    clickHeader("Name");
    expect(names()).toEqual(["Cy", "Bea", "Ada"]);
    expect(header("Name").getAttribute("aria-sort")).toBe("descending");

    // The third click restores the caller's order rather than sticking on
    // descending, so the server's ordering stays reachable without a reload.
    clickHeader("Name");
    expect(names()).toEqual(["Bea", "Ada", "Cy"]);
    expect(header("Name").getAttribute("aria-sort")).toBe("none");
  });

  it("sorts numbers numerically, not as text", () => {
    render(PEOPLE);
    clickHeader("Seats");

    // "10" sorts before "2" as a string. This is the whole reason `sortValue`
    // is separate from `cell`: the cell renders text, the sort sees the number.
    expect(names()).toEqual(["Cy", "Bea", "Ada"]);
  });

  it("sorts unknown values last in both directions", () => {
    render(PEOPLE);

    clickHeader("Email");
    // Ada has no email. Treating null as less-than would file her under "A"
    // and invite the reader to believe that is her address.
    expect(names().at(-1)).toBe("Ada");

    clickHeader("Email");
    expect(names().at(-1)).toBe("Ada");
  });

  it("does not offer a sort on a column that has no sort value", () => {
    render(PEOPLE);

    // `aria-sort="none"` on a column that can never sort announces a control
    // that is not there.
    expect(header("Actions").hasAttribute("aria-sort")).toBe(false);
    expect(header("Actions").querySelector("button")).toBeNull();
  });

  it("keeps rows that share a sort value in their original relative order", () => {
    /* The directory interleaves an expanded detail row directly after its
       parent and gives both the same sort value; a stable sort is what keeps
       the pair together instead of flinging the detail to the far end. */
    const twins: readonly Person[] = [
      { id: "row", name: "Same", seats: 1, email: "a@helix.test" },
      { id: "detail", name: "Same", seats: 1, email: "b@helix.test" },
      { id: "other", name: "Aardvark", seats: 3, email: "c@helix.test" },
    ];
    render(twins);
    clickHeader("Name");

    const ids = [...container.querySelectorAll("tbody tr")].map(
      (row) => row.querySelectorAll("td")[2]?.textContent,
    );
    expect(ids).toEqual(["c@helix.test", "a@helix.test", "b@helix.test"]);
  });

  it("renders an empty explanation rather than an empty table", () => {
    render([], { empty: "No people yet." });

    expect(container.textContent).toContain("No people yet.");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("names the table for assistive tech", () => {
    render(PEOPLE);
    expect(container.querySelector("table")?.getAttribute("aria-label")).toBe("People");
  });

  it("stays plain DOM for a short table and virtualizes a long one", () => {
    render(PEOPLE);
    // No scroll container, no padding rows: virtualizing three rows costs a
    // measured height and two spacer rows to save nothing.
    expect(container.querySelector(".admin-table-scroll")).toBeNull();

    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `p-${String(index)}`,
      name: `Person ${String(index).padStart(3, "0")}`,
      seats: index,
      email: null,
    }));
    render(many);

    const scroll = container.querySelector(".admin-table-scroll");
    expect(scroll).not.toBeNull();
    // Reachable from the keyboard — a scroll region nobody can focus is a
    // region a keyboard user cannot read past the first screen.
    expect(scroll?.getAttribute("tabindex")).toBe("0");
    // Windowed, not all 400 in the DOM.
    expect(container.querySelectorAll("tbody tr").length).toBeLessThan(many.length);
  });

  it("says so when a sort only covers the rows that are loaded", () => {
    render(PEOPLE, { partialNote: "Sorted within the 3 rows loaded so far." });

    // Silent until the column is actually sorted — the caveat belongs to the
    // claim, and there is no claim until something is sorted.
    expect(container.textContent).not.toContain("loaded so far");

    clickHeader("Name");
    expect(container.textContent).toContain("Sorted within the 3 rows loaded so far.");
  });
});
