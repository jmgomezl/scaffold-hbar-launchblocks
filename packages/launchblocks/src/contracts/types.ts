import type { Abi } from "viem";

/** A compiled contract, as the Deploy contract block needs it. */
export type ContractArtifact = {
  contractName: string;
  /** `contracts/TokenLock.sol` */
  sourceName: string;
  abi: Abi;
  bytecode: `0x${string}`;
};

/**
 * Where a run gets compiled contracts from: the Hardhat artifacts on disk on
 * the server (`loadHardhatArtifact`), or the app's artifacts API in the browser.
 */
export type ArtifactLoader = (name: string) => ContractArtifact | Promise<ContractArtifact>;

/** `TokenLock`, or `TokenLock.sol:TokenLock` when two files declare the same name. */
export const CONTRACT_NAME_PATTERN = /^(?:[\w/.-]+\.sol:)?[A-Za-z_$][\w$]*$/;
