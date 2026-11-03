import type { StepRegistry } from "../registry/registry";
import { createRegistry } from "../registry/registry";
import type { AnyStepDefinition } from "../registry/types";
import { contractCall } from "./contract/call";
import { contractDeploy } from "./contract/deploy";
import { hcsCreateTopic } from "./hcs/create-topic";
import { hcsSubmitMessage } from "./hcs/submit-message";
import { hssScheduleMint } from "./hss/schedule-mint";
import { hssScheduleTransfer } from "./hss/schedule-transfer";
import { hssSelfReleasingLock } from "./hss/self-releasing-lock";
import { hssVesting } from "./hss/vesting";
import { htsAirdrop } from "./hts/airdrop";
import { htsAssociate } from "./hts/associate";
import { htsCreateToken } from "./hts/create-token";
import { htsMint } from "./hts/mint";
import { htsTransfer } from "./hts/transfer";
import { oraclePriceInUsdStep } from "./oracle/price-in-usd";
import { pythPriceInUsd } from "./pyth/price-in-usd";
import { saucerswapCreatePool } from "./saucerswap/create-pool";
import { saucerswapSwap } from "./saucerswap/swap";

/** Every step type this template ships, in palette order. */
export const BUILT_IN_STEPS: readonly AnyStepDefinition[] = [
  htsCreateToken,
  htsMint,
  htsTransfer,
  htsAirdrop,
  htsAssociate,
  hcsCreateTopic,
  hcsSubmitMessage,
  hssScheduleTransfer,
  hssScheduleMint,
  hssSelfReleasingLock,
  hssVesting,
  oraclePriceInUsdStep,
  pythPriceInUsd,
  saucerswapCreatePool,
  saucerswapSwap,
  contractDeploy,
  contractCall,
];

export function createDefaultRegistry(extra: readonly AnyStepDefinition[] = []): StepRegistry {
  return createRegistry([...BUILT_IN_STEPS, ...extra]);
}

export {
  contractCall,
  contractDeploy,
  hcsCreateTopic,
  hcsSubmitMessage,
  hssScheduleMint,
  hssScheduleTransfer,
  hssSelfReleasingLock,
  hssVesting,
  htsAirdrop,
  htsAssociate,
  htsCreateToken,
  htsMint,
  htsTransfer,
  oraclePriceInUsdStep,
  pythPriceInUsd,
  saucerswapCreatePool,
  saucerswapSwap,
};
export * from "./shared";
