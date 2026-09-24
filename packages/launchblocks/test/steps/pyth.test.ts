import { describe, expect, it } from "vitest";

import { generateLaunchScript } from "../../src/codegen/typescript";
import { createDefaultRegistry } from "../../src/steps";
import { pythPriceInUsd } from "../../src/steps/pyth/price-in-usd";

describe("pyth.priceInUsd", () => {
  it("defaults to a two-minute age limit and a 1% confidence limit", () => {
    const input = pythPriceInUsd.input.parse({ tokenAmount: "50000", tokenPriceUsd: "0.00002" });
    expect(input).toMatchObject({ maxAgeSeconds: 120, maxConfidenceBps: 100 });
    expect(() => pythPriceInUsd.input.parse({ tokenAmount: "0", tokenPriceUsd: "1" })).toThrow();
  });

  it("feeds a pool: its Tokens and HBAR outputs wire into Seed SaucerSwap pool", () => {
    const registry = createDefaultRegistry();
    const flow = registry.validateFlow({
      schemaVersion: 1,
      id: "usd-pool",
      name: "USD pool",
      network: "testnet",
      steps: [
        {
          id: "createToken",
          type: "hts.createToken",
          params: { name: "USD Demo", symbol: "USD", initialSupply: "1000000" },
        },
        { id: "price", type: "pyth.priceInUsd", params: { tokenAmount: "50000", tokenPriceUsd: "0.00002" } },
        {
          id: "seedPool",
          type: "saucerswap.createPool",
          params: {
            tokenId: "{{steps.createToken.tokenId}}",
            tokenAmount: "{{steps.price.tokenAmount}}",
            hbarAmount: "{{steps.price.hbarAmount}}",
          },
        },
      ],
    });
    const source = generateLaunchScript(flow, registry);
    expect(source).toContain('await priceInUsd(ctx, { tokenAmount: "50000", tokenPriceUsd: "0.00002"');
    expect(source).toContain("hbarAmount: price.hbarAmount");
  });
});
