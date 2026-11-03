import { describe, expect, it } from "vitest";

import { generateLaunchScript } from "../../src/codegen/typescript";
import { createDefaultRegistry } from "../../src/steps";
import { oraclePriceInUsdStep } from "../../src/steps/oracle/price-in-usd";

describe("oracle.priceInUsd", () => {
  it("defaults to Chainlink's heartbeat plus an hour and a 1% cross-check limit", () => {
    const input = oraclePriceInUsdStep.input.parse({ tokenAmount: "50000", tokenPriceUsd: "0.00002" });
    expect(input).toMatchObject({ maxAgeSeconds: 90_000, maxDeviationBps: 100 });
    expect(() => oraclePriceInUsdStep.input.parse({ tokenAmount: "0", tokenPriceUsd: "1" })).toThrow();
  });

  it("feeds a pool: its Tokens and HBAR outputs wire into Seed SaucerSwap pool, and export calls the core", () => {
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
        { id: "price", type: "oracle.priceInUsd", params: { tokenAmount: "50000", tokenPriceUsd: "0.00002" } },
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
    expect(source).toContain('await oraclePriceInUsd(ctx, { tokenAmount: "50000", tokenPriceUsd: "0.00002"');
    expect(source).toMatch(/import \{[^}]*oraclePriceInUsd[^}]*\} from "@sh\/launchblocks"/);
  });
});
