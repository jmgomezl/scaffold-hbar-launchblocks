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
  /** SaucerSwapV1RouterV3.getAmountsOut(uint256,address[]) → uint256[] */
  getAmountsOut: "0xd06ca61f",
} as const;

/**
 * Gas for `SaucerSwapV1Factory.createPair`, which deploys the pair, creates
 * its LP token and associates it. Measured at 5,849,994 on testnet; at
 * 3,000,000 it reverts with "Safe multiple associations failed!" after
 * consuming 2,991,757. (The docs quote 3,200,000 for the router's one-call
 * pool creation, which does the same work and more; measured at 6,788,255.)
 */
export const CREATE_PAIR_GAS = 8_000_000;

/** Gas for `addLiquidityETH` into a freshly created pair; measured at 974,522 on testnet. */
export const ADD_LIQUIDITY_GAS = 2_000_000;

/**
 * Margin added to the quoted creation fee, in basis points. Overpayment is
 * forwarded by the factory to SaucerSwap's rent payer, so it never touches
 * the pool; underpayment reverts createPair before any liquidity moves.
 */
export const DEFAULT_FEE_BUFFER_BPS = 200;

/**
 * Gas for a single-hop `swapExactETHForTokens`: wrap HBAR, pay the pair,
 * swap. Measured well under this on testnet; the headroom covers tokens that
 * need an automatic association on receipt.
 */
export const SWAP_GAS = 2_000_000;

/** Gas for an ERC-20 facade `approve` on an HTS token. */
export const APPROVE_GAS = 1_000_000;
