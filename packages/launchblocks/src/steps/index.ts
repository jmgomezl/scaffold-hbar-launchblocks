import type { StepRegistry } from "../registry/registry";
import { createRegistry } from "../registry/registry";
import type { AnyStepDefinition } from "../registry/types";
import { contractCall } from "./contract/call";
import { contractDeploy } from "./contract/deploy";
import { hcsCreateTopic } from "./hcs/create-topic";
import { hcsSubmitMessage } from "./hcs/submit-message";
import { htsAirdrop } from "./hts/airdrop";
import { htsAssociate } from "./hts/associate";
import { htsCreateToken } from "./hts/create-token";
import { htsMint } from "./hts/mint";
import { htsTransfer } from "./hts/transfer";
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
  htsAirdrop,
  htsAssociate,
  htsCreateToken,
  htsMint,
  htsTransfer,
  saucerswapCreatePool,
  saucerswapSwap,
};
export * from "./shared";
