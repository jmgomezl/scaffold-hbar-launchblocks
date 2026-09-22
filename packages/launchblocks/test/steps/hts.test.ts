import { describe, expect, it } from "vitest";

import { renderExpr } from "../../src/codegen/typescript";
import { ref } from "../../src/flow/refs";
import type { CodegenContext } from "../../src/registry/types";
import { createDefaultRegistry, htsAirdrop, htsCreateToken, htsMint } from "../../src/steps";

const registry = createDefaultRegistry();

function codegenWith(params: Record<string, unknown>) {
  const imports: string[] = [];
  const ctx: CodegenContext = {
    stepId: "s",
    coreModule: "core",
    expr: key => renderExpr(params[key]),
    addImport: (_specifier, ...names) => imports.push(...names),
  };
  return { imports, ...htsCreateToken.codegen(ctx) };
}

describe("hts.createToken input", () => {
  it("applies defaults, including nested key defaults", () => {
    const input = htsCreateToken.input.parse({ name: "Demo", symbol: "DMO" });
    expect(input).toEqual({
      name: "Demo",
      symbol: "DMO",
      decimals: 8,
      initialSupply: "1000000",
      supplyType: "infinite",
      keys: { admin: true, supply: true, freeze: false, wipe: false, pause: false, kyc: false, feeSchedule: false },
    });
  });

  it("lets a partial keys object override only what it names", () => {
    const input = htsCreateToken.input.parse({ name: "Demo", symbol: "DMO", keys: { supply: false, kyc: true } });
    expect(input.keys).toMatchObject({ admin: true, supply: false, kyc: true });
  });

  it("requires maxSupply for finite supply", () => {
    const result = htsCreateToken.input.safeParse({ name: "Demo", symbol: "DMO", supplyType: "finite" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["maxSupply"]);
  });

  it("rejects out-of-range decimals and empty names", () => {
    expect(htsCreateToken.input.safeParse({ name: "Demo", symbol: "DMO", decimals: 19 }).success).toBe(false);
    expect(htsCreateToken.input.safeParse({ name: " ", symbol: "DMO" }).success).toBe(false);
  });

  it("accepts large supplies as strings and rejects negative numbers", () => {
    expect(htsCreateToken.input.safeParse({ name: "D", symbol: "D", initialSupply: "50000000000" }).success).toBe(true);
    expect(htsCreateToken.input.safeParse({ name: "D", symbol: "D", initialSupply: -1 }).success).toBe(false);
  });
});

describe("hts.createToken codegen", () => {
  it("emits a single call with only the params that are set", () => {
    const { body, imports } = codegenWith({
      name: "Demo",
      symbol: "DMO",
      decimals: 8,
      initialSupply: "1000000",
      supplyType: "infinite",
      keys: { admin: true, supply: true, freeze: false, wipe: false, pause: false, kyc: false, feeSchedule: false },
    });
    expect(imports).toEqual(["createFungibleToken"]);
    expect(body).toBe(
      'return await createFungibleToken(ctx, { name: "Demo", symbol: "DMO", decimals: 8, initialSupply: "1000000", supplyType: "infinite", keys: { admin: true, supply: true, freeze: false, wipe: false, pause: false, kyc: false, feeSchedule: false } });',
    );
  });
});

describe("hts.mint / hts.airdrop inputs", () => {
  it("rejects zero amounts", () => {
    expect(htsMint.input.safeParse({ tokenId: "0.0.1", amount: 0 }).success).toBe(false);
    expect(htsMint.input.safeParse({ tokenId: "0.0.1", amount: "0.0" }).success).toBe(false);
    expect(htsMint.input.safeParse({ tokenId: "0.0.1", amount: "0.5" }).success).toBe(true);
  });

  it("bounds airdrop recipients to 1..10", () => {
    expect(htsAirdrop.input.safeParse({ tokenId: "0.0.1", recipients: [] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ accountId: `0.0.${i}`, amount: 1 }));
    expect(htsAirdrop.input.safeParse({ tokenId: "0.0.1", recipients: eleven }).success).toBe(false);
  });
});

describe("wiring through the default registry", () => {
  it("accepts token id and text outputs where they fit and rejects a number for a token id", () => {
    const base = { schemaVersion: 1, id: "w", name: "w" };
    const ok = registry.checkFlow({
      ...base,
      steps: [
        { id: "createToken", type: "hts.createToken", params: { name: "D", symbol: "D" } },
        { id: "mint", type: "hts.mint", params: { tokenId: ref("createToken", "tokenId"), amount: 1 } },
      ],
    });
    expect(ok.issues).toEqual([]);

    const bad = registry.checkFlow({
      ...base,
      steps: [
        { id: "createToken", type: "hts.createToken", params: { name: "D", symbol: "D" } },
        { id: "mint", type: "hts.mint", params: { tokenId: ref("createToken", "decimals"), amount: 1 } },
      ],
    });
    expect(bad.issues[0]?.path).toBe("steps[1].params.tokenId");
  });
});
