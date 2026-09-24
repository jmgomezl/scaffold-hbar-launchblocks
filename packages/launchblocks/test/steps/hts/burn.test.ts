import { describe, expect, it } from "vitest";

import { renderExpr } from "../../../src/codegen/typescript";
import type { CodegenContext } from "../../../src/registry/types";
import { htsBurn } from "../../../src/steps";

describe("hts.burn input", () => {
  it("rejects a zero or negative amount", () => {
    expect(htsBurn.input.safeParse({ tokenId: "0.0.1", amount: 0 }).success).toBe(false);
    expect(htsBurn.input.safeParse({ tokenId: "0.0.1", amount: -5 }).success).toBe(false);
    expect(htsBurn.input.safeParse({ tokenId: "0.0.1", amount: "0.5" }).success).toBe(true);
  });

  it("rejects a malformed token id", () => {
    expect(htsBurn.input.safeParse({ tokenId: "not-a-token", amount: 1 }).success).toBe(false);
    expect(htsBurn.input.safeParse({ tokenId: "0.0.1", amount: 1 }).success).toBe(true);
  });
});

describe("hts.burn codegen", () => {
  it("calls burnFungibleToken with tokenId and amount", () => {
    const params = { tokenId: "0.0.1", amount: "100000" };
    const imports: string[] = [];
    const ctx: CodegenContext = {
      stepId: "s",
      coreModule: "core",
      expr: key => renderExpr(params[key as keyof typeof params]),
      addImport: (_specifier, ...names) => imports.push(...names),
    };
    const { body } = htsBurn.codegen(ctx);
    expect(imports).toEqual(["burnFungibleToken"]);
    expect(body).toBe('return await burnFungibleToken(ctx, { tokenId: "0.0.1", amount: "100000" });');
  });
});
