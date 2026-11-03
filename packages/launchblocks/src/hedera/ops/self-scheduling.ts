import type { ContractArtifact } from "../../contracts/types";
import { LaunchBlocksError } from "../../errors";
import { evmAddressToEntityId } from "../abi";
import type { DecimalAmount } from "../amounts";
import type { HederaContext } from "../context";
import { callContract, deployContract } from "./contracts";
import { transferFungibleToken } from "./tokens";

/**
 * Contracts that book their own future calls with the Hedera Schedule Service (HIP-1215):
 * SelfReleasingLock and VestingSchedule in packages/hardhat/contracts. Each is deployed, armed (it
 * books its first run, paid for with the HBAR sent along) and funded with the tokens it pays out.
 * From then on the network runs it on time with nobody online, and the HBAR left after the last run
 * goes back to the operator.
 */

/** Gas to deploy either contract as an Ethereum transaction; the mirror node estimated 0.92M and 0.97M. */
export const SELF_SCHEDULING_DEPLOY_GAS = 1_200_000;
/** Booking a call through 0x16b used 1.41M gas on testnet; arm() used 1.48M in all. */
export const ARM_GAS = 1_900_000;
/**
 * Gas limit of each run the network makes. A run that books the next one (a vesting tranche, a
 * lock's hop) spends about 1.41M on the booking alone. Runs are charged for the gas they use.
 */
export const SCHEDULED_RUN_GAS = 2_000_000;

/** Longest single booking the contracts make: `MAX_HOP` (60 days) less the 16 seconds they probe for capacity. */
export const MAX_HOP_SECONDS = 60 * 24 * 60 * 60 - 16;
/**
 * HBAR for one run that books the next (1.41M gas for the booking at testnet's 106 tinybar per gas,
 * plus the run's own work), rounded up. The contract pays it from the HBAR parked in it.
 */
export const BOOKING_RUN_HBAR = 1.7;
/** HBAR for one run that pays out tokens and refunds the HBAR left, rounded up. */
export const PAYOUT_RUN_HBAR = 0.2;

/** Runs the network makes for a wait of `seconds` that ends in a payout: one hop per 60 days. */
const hopsFor = (seconds: number) => Math.max(0, Math.ceil(seconds / MAX_HOP_SECONDS) - 1);

/** HBAR a schedule's runs need: one payout run per payment, one booking run per hop or next payment. */
function hbarFor(bookings: number, payouts: number): number {
  return Math.round((bookings * BOOKING_RUN_HBAR + payouts * PAYOUT_RUN_HBAR) * 100) / 100;
}

/** HBAR a SelfReleasingLock needs for its runs: the release, plus a hop for every 60 days beyond the first. */
export function lockRunHbar(lockSeconds: number): number {
  return hbarFor(hopsFor(lockSeconds), 1);
}

/** HBAR a VestingSchedule needs for its runs: every tranche pays out, and all but the last book the next. */
export function vestingRunHbar(startInSeconds: number, intervalSeconds: number, tranches: number): number {
  const hops = hopsFor(startInSeconds) + (tranches - 1) * hopsFor(intervalSeconds);
  return hbarFor(hops + tranches - 1, tranches);
}

export type SelfSchedulingFunding = {
  /**
   * HBAR parked in the contract to pay the network's runs; what is left goes back to the operator.
   * Defaults to what the schedule needs ({@link lockRunHbar}, {@link vestingRunHbar}).
   */
  runHbar?: DecimalAmount | undefined;
  /** Gas limit of each scheduled run; defaults to SCHEDULED_RUN_GAS. */
  scheduledGas?: number | undefined;
};

export type SelfReleasingLockParams = SelfSchedulingFunding & {
  /** Compiled SelfReleasingLock. */
  artifact: ContractArtifact;
  tokenId: string;
  /** Tokens to lock, in whole tokens (1.5 is one and a half). */
  amount: DecimalAmount;
  /** Who receives the tokens at release. */
  beneficiary: string;
  lockSeconds: number;
};

export type VestingScheduleParams = SelfSchedulingFunding & {
  /** Compiled VestingSchedule. */
  artifact: ContractArtifact;
  tokenId: string;
  /** Tokens to vest in all, in whole tokens. */
  amount: DecimalAmount;
  beneficiary: string;
  /** Seconds from now to the first tranche. */
  startInSeconds: number;
  /** Seconds between tranches, at least 60. */
  intervalSeconds: number;
  tranches: number;
};

export type SelfSchedulingResult = {
  contractId: string;
  /** The same entity as an account, for steps that take one. */
  accountId: string;
  evmAddress: string;
  /** The schedule the network will run next. */
  scheduleId: string;
  /** ISO time of that run: the release, a tranche, or a hop toward a release beyond 60 days. */
  nextRunAt: string;
  /** Smallest units moved into the contract. */
  amountUnits: string;
  /** HBAR parked in the contract for the network's runs. */
  runHbar: string;
  deployTransactionId: string;
  armTransactionId: string;
  fundTransactionId: string;
};

export type SelfReleasingLockResult = SelfSchedulingResult & {
  /** ISO time from which the tokens go to the beneficiary. */
  releaseAt: string;
};

export type VestingScheduleResult = SelfSchedulingResult & {
  /** ISO time of the first tranche. */
  firstTrancheAt: string;
  tranches: number;
};

const isoFromSeconds = (seconds: unknown) => new Date(Number(seconds) * 1000).toISOString();

/**
 * Arm a deployed self-scheduling contract, fund it with the tokens, and read back what the network
 * will run. Arming comes first: if it fails, no tokens have moved. A failure after the deploy names
 * the contract, which keeps a manual `release()` for anything that reaches it.
 */
async function armAndFund(
  hedera: HederaContext,
  deployed: Awaited<ReturnType<typeof deployContract>>,
  params: { tokenId: string; amount: DecimalAmount; runHbar: DecimalAmount },
  signal?: AbortSignal,
): Promise<SelfSchedulingResult> {
  const { contractId } = deployed;
  const describe = (error: unknown, what: string) => {
    if (!(error instanceof LaunchBlocksError)) return error;
    return new LaunchBlocksError(error.code, `${what} contract ${contractId}: ${error.message}`, {
      cause: error,
      hint: error.hint ?? `Contract ${contractId} is deployed; check it on HashScan before running again.`,
    });
  };
  const arm = await callContract(
    hedera,
    { contractId, function: "function arm() payable", payableHbar: params.runHbar, gas: ARM_GAS },
    signal,
  ).catch((error: unknown) => {
    throw describe(error, "Arming");
  });
  const fund = await transferFungibleToken(hedera, {
    tokenId: params.tokenId,
    to: contractId,
    amount: params.amount,
  }).catch((error: unknown) => {
    throw describe(error, "Funding");
  });
  const read = async (signature: string) =>
    (await callContract(hedera, { contractId, function: signature }, signal)).values[0];
  const [expiry, schedule] = await Promise.all([
    read("function pendingExpiry() view returns (uint256)"),
    read("function pendingSchedule() view returns (address)"),
  ]);
  return {
    contractId,
    accountId: contractId,
    evmAddress: deployed.evmAddress,
    scheduleId: evmAddressToEntityId(String(schedule)),
    nextRunAt: isoFromSeconds(expiry),
    amountUnits: fund.amountUnits,
    runHbar: String(params.runHbar),
    deployTransactionId: deployed.transactionId,
    armTransactionId: arm.transactionId ?? "",
    fundTransactionId: fund.transactionId,
  };
}

/**
 * Lock tokens in a SelfReleasingLock that the network releases to `beneficiary` after
 * `lockSeconds`, with no keeper: deploy, arm, fund.
 */
export async function createSelfReleasingLock(
  hedera: HederaContext,
  params: SelfReleasingLockParams,
  signal?: AbortSignal,
): Promise<SelfReleasingLockResult> {
  const deployed = await deployContract(
    hedera,
    {
      artifact: params.artifact,
      args: [
        params.tokenId,
        params.beneficiary,
        params.lockSeconds,
        hedera.operatorId.toString(),
        params.scheduledGas ?? SCHEDULED_RUN_GAS,
      ],
      autoAssociations: 1,
      gas: SELF_SCHEDULING_DEPLOY_GAS,
    },
    signal,
  );
  const runHbar = params.runHbar ?? lockRunHbar(params.lockSeconds);
  const result = await armAndFund(hedera, deployed, { ...params, runHbar }, signal);
  const releaseTime = (
    await callContract(
      hedera,
      { contractId: deployed.contractId, function: "function releaseTime() view returns (uint256)" },
      signal,
    )
  ).values[0];
  return { ...result, releaseAt: isoFromSeconds(releaseTime) };
}

/**
 * Vest tokens to `beneficiary` in equal tranches that the network pays by itself: each payment
 * books the next one. Deploy, arm, fund.
 */
export async function createVestingSchedule(
  hedera: HederaContext,
  params: VestingScheduleParams,
  signal?: AbortSignal,
): Promise<VestingScheduleResult> {
  const deployed = await deployContract(
    hedera,
    {
      artifact: params.artifact,
      args: [
        params.tokenId,
        params.beneficiary,
        params.startInSeconds,
        params.intervalSeconds,
        params.tranches,
        hedera.operatorId.toString(),
        params.scheduledGas ?? SCHEDULED_RUN_GAS,
      ],
      autoAssociations: 1,
      gas: SELF_SCHEDULING_DEPLOY_GAS,
    },
    signal,
  );
  const runHbar = params.runHbar ?? vestingRunHbar(params.startInSeconds, params.intervalSeconds, params.tranches);
  const result = await armAndFund(hedera, deployed, { ...params, runHbar }, signal);
  const start = (
    await callContract(
      hedera,
      { contractId: deployed.contractId, function: "function start() view returns (uint256)" },
      signal,
    )
  ).values[0];
  return { ...result, firstTrancheAt: isoFromSeconds(start), tranches: params.tranches };
}
