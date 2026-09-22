import type { StepRegistry } from "../registry/registry";
import { createRegistry } from "../registry/registry";
import type { AnyStepDefinition } from "../registry/types";
import { hcsCreateTopic } from "./hcs/create-topic";
import { hcsSubmitMessage } from "./hcs/submit-message";
import { htsAirdrop } from "./hts/airdrop";
import { htsAssociate } from "./hts/associate";
import { htsCreateToken } from "./hts/create-token";
import { htsMint } from "./hts/mint";
import { htsTransfer } from "./hts/transfer";

/** Every step type this template ships, in palette order. */
export const BUILT_IN_STEPS: readonly AnyStepDefinition[] = [
  htsCreateToken,
  htsMint,
  htsTransfer,
  htsAirdrop,
  htsAssociate,
  hcsCreateTopic,
  hcsSubmitMessage,
];

export function createDefaultRegistry(extra: readonly AnyStepDefinition[] = []): StepRegistry {
  return createRegistry([...BUILT_IN_STEPS, ...extra]);
}

export { hcsCreateTopic, hcsSubmitMessage, htsAirdrop, htsAssociate, htsCreateToken, htsMint, htsTransfer };
export * from "./shared";
