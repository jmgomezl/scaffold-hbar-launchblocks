import { describe, expect, it } from "vitest";

import { STEPS_END, STEPS_START, injectBetweenMarkers, renderStepsTable } from "../../src/docs/steps-table";
import { createDefaultRegistry } from "../../src/steps";

describe("renderStepsTable()", () => {
  const table = renderStepsTable(createDefaultRegistry());

  it("has one row per registered step", () => {
    const rows = table.split("\n").slice(2);
    expect(rows).toHaveLength(createDefaultRegistry().list().length);
    expect(table).toContain("| `saucerswap.createPool` |");
    expect(table).toContain("SaucerSwap");
  });

  it("escapes pipes so a summary cannot break the table", () => {
    const cells = table.split("\n")[2]?.split(/(?<!\\)\|/) ?? [];
    expect(cells.length).toBe(7);
  });
});

describe("injectBetweenMarkers()", () => {
  it("replaces only the content between the markers, idempotently", () => {
    const doc = `# Title\n${STEPS_START}\nold\n${STEPS_END}\ntail`;
    const once = injectBetweenMarkers(doc, "new");
    expect(once).toBe(`# Title\n${STEPS_START}\nnew\n${STEPS_END}\ntail`);
    expect(injectBetweenMarkers(once, "new")).toBe(once);
  });

  it("refuses a document without markers", () => {
    expect(() => injectBetweenMarkers("# nothing", "x")).toThrow(/not found/);
  });
});
