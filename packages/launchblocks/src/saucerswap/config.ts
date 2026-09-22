import { LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";

/**
 * SaucerSwap deployments, from the official contract deployments page.
 * Verified against testnet on 2026-09-22 by reading `pairCreateFee()` on the
 * V1 factory and `whbar()` on the V1 router.
 *
 * @see https://docs.saucerswap.finance/developerx/contract-deployments
 */
export type SaucerSwapDeployment = {
  /** SaucerSwapV1Factory — creates V1 pools and prices pool creation. */
  v1Factory: string;
  /** SaucerSwapV1RouterV3 — the router this template calls. */
  v1Router: string;
  /** SaucerSwapV2Factory. */
  v2Factory: string;
  /** SaucerSwapV2SwapRouter. */
  v2SwapRouter: string;
  /** SaucerSwapV2QuoterV2 — gas-free quotes. */
  v2Quoter: string;
  /** The WHBAR HTS token (what pools actually hold), not the WHBAR contract. */
  whbarToken: string;
  /** The WHBAR contract that wraps and unwraps HBAR. */
  whbarContract: string;
  /** Where a human verifies a pool. */
  appBaseUrl: string;
};

export const SAUCERSWAP_DEPLOYMENTS: Partial<Record<Network, SaucerSwapDeployment>> = {
  mainnet: {
    v1Factory: "0.0.1062784",
    v1Router: "0.0.3045981",
    v2Factory: "0.0.3946833",
    v2SwapRouter: "0.0.3949434",
    v2Quoter: "0.0.3949424",
    whbarToken: "0.0.1456986",
    whbarContract: "0.0.1456985",
    appBaseUrl: "https://www.saucerswap.finance",
  },
  testnet: {
    v1Factory: "0.0.9959",
    v1Router: "0.0.19264",
    v2Factory: "0.0.1197038",
    v2SwapRouter: "0.0.1414040",
    v2Quoter: "0.0.1390002",
    whbarToken: "0.0.15058",
    whbarContract: "0.0.15057",
    appBaseUrl: "https://testnet.saucerswap.finance",
  },
};

export function saucerswapFor(network: Network): SaucerSwapDeployment {
  const deployment = SAUCERSWAP_DEPLOYMENTS[network];
  if (!deployment) {
    throw new LaunchBlocksError(
      "SAUCERSWAP_UNAVAILABLE",
      `SaucerSwap is not deployed on ${network}; run this flow against testnet or mainnet`,
    );
  }
  return deployment;
}

/** Function selectors used by the read and write calls below. */
export const SELECTORS = {
  /** SaucerSwapV1Factory.pairCreateFee() → uint256 tinycents */
  pairCreateFee: "0x881a075a",
  /** SaucerSwapV1Factory.getPair(address,address) → address */
  getPair: "0xe6a43905",
} as const;

/**
 * Gas for `addLiquidityETHNewPool`.
 *
 * The SaucerSwap docs quote 3,200,000, but that is not enough in practice:
 * the router associates the freshly deployed pair with both tokens through
 * the HTS precompile, and a run measured on testnet consumed 3,138,305 gas
 * before reverting with "Safe multiple associations failed!" — the router's
 * own guard reporting that its association sub-call ran out of gas. The
 * default below leaves headroom for that path; Hedera allows up to
 * 15,000,000 per transaction.
 */
export const CREATE_POOL_GAS = 5_000_000;
