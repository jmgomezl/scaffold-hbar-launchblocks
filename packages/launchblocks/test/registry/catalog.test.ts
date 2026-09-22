import { describe, expect, it } from "vitest";

import { stepCatalog } from "../../src/registry/catalog";
import { createDefaultRegistry } from "../../src/steps";

describe("stepCatalog()", () => {
  const catalog = stepCatalog(createDefaultRegistry());

  it("describes every registered step with a JSON schema", () => {
    expect(catalog.map(entry => entry.type)).toContain("hts.createToken");
    const createToken = catalog.find(entry => entry.type === "hts.createToken");
    expect(createToken?.inputSchema).toMatchObject({ type: "object" });
    const properties = createToken?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["name", "symbol", "decimals", "initialSupply", "keys", "fractionalFee"]),
    );
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(catalog)).not.toThrow();
    expect(JSON.parse(JSON.stringify(catalog))).toHaveLength(catalog.length);
  });
});
