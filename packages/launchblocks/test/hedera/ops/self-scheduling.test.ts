import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContractArtifact } from "../../../src/contracts/types";
import { LaunchBlocksError } from "../../../src/errors";
import { callContract, deployContract } from "../../../src/hedera/ops/contracts";
import {
  ARM_GAS,
  SCHEDULED_RUN_GAS,
  createSelfReleasingLock,
  createVestingSchedule,
  lockRunHbar,
  vestingRunHbar,
} from "../../../src/hedera/ops/self-scheduling";
import { transferFungibleToken } from "../../../src/hedera/ops/tokens";
import { offlineHederaContext } from "../../helpers/hedera";

vi.mock("../../../src/hedera/ops/contracts", () => ({ deployContract: vi.fn(), callContract: vi.fn() }));
vi.mock("../../../src/hedera/ops/tokens", () => ({ transferFungibleToken: vi.fn() }));

afterEach(() => vi.clearAllMocks());

const DAY = 86_400;
const artifact = { contractName: "SelfReleasingLock" } as ContractArtifact;

/** The network side: a deploy, an arm, a transfer, and the reads that follow. */
function mockNetwork(reads: Record<string, unknown>) {
  const order: string[] = [];
  vi.mocked(deployContract).mockImplementation(async () => {
    order.push("deploy");
    return {
      contract: "SelfReleasingLock",
      contractId: "0.0.700",
      accountId: "0.0.700",
      evmAddress: "0xabc",
      transactionId: "0.0.4242@1.1",
      gasUsed: 900_000,
    };
  });
  vi.mocked(callContract).mockImplementation(async (_hedera, params) => {
    const name = /function (\w+)/.exec(params.function)?.[1] ?? "";
    if (name === "arm") {
      order.push("arm");
      return { transactionId: "0.0.4242@2.2" } as never;
    }
    return { values: [reads[name]] } as never;
  });
  vi.mocked(transferFungibleToken).mockImplementation(async (_hedera, params) => {
    order.push("fund");
    return { tokenId: params.tokenId, to: params.to, amountUnits: "100000000000", transactionId: "0.0.4242@3.3" };
  });
  return order;
}

describe("HBAR for the network's runs", () => {
  it("pays a release run, plus a hop for every 60 days beyond the first", () => {
    expect(lockRunHbar(30 * DAY)).toBe(0.2);
    expect(lockRunHbar(60 * DAY - 16)).toBe(0.2);
    expect(lockRunHbar(90 * DAY)).toBe(1.9);
    expect(lockRunHbar(365 * DAY)).toBe(10.4);
  });

  it("pays every tranche, and a booking for each tranche but the last", () => {
    expect(vestingRunHbar(60, 60, 1)).toBe(0.2);
    expect(vestingRunHbar(30 * DAY, 30 * DAY, 12)).toBe(21.1);
    // A 90-day interval hops once between tranches; a 90-day start hops once before the first.
    expect(vestingRunHbar(90 * DAY, 90 * DAY, 3)).toBe(1.7 * (1 + 2 + 2) + 0.6);
  });
});

describe("createSelfReleasingLock()", () => {
  it("deploys, arms with the HBAR the runs need, funds, and reports the network's next run", async () => {
    const order = mockNetwork({
      pendingExpiry: 1792685009n,
      pendingSchedule: "0x0000000000000000000000000000000000a9d627",
      releaseTime: 1792685009n,
    });
    const hedera = offlineHederaContext();
    const result = await createSelfReleasingLock(hedera, {
      artifact,
      tokenId: "0.0.500",
      amount: "1000",
      beneficiary: "0.0.4242",
      lockSeconds: 30 * DAY,
    });

    expect(order).toEqual(["deploy", "arm", "fund"]);
    expect(vi.mocked(deployContract).mock.calls[0]![1]).toMatchObject({
      args: ["0.0.500", "0.0.4242", 30 * DAY, "0.0.4242", SCHEDULED_RUN_GAS],
      autoAssociations: 1,
    });
    expect(vi.mocked(callContract).mock.calls[0]![1]).toEqual({
      contractId: "0.0.700",
      function: "function arm() payable",
      payableHbar: 0.2,
      gas: ARM_GAS,
    });
    expect(result).toEqual({
      contractId: "0.0.700",
      accountId: "0.0.700",
      evmAddress: "0xabc",
      scheduleId: "0.0.11130407",
      nextRunAt: "2026-10-22T16:03:29.000Z",
      amountUnits: "100000000000",
      runHbar: "0.2",
      deployTransactionId: "0.0.4242@1.1",
      armTransactionId: "0.0.4242@2.2",
      fundTransactionId: "0.0.4242@3.3",
      releaseAt: "2026-10-22T16:03:29.000Z",
    });
  });

  it("moves no tokens when arming fails, and names the contract", async () => {
    const order = mockNetwork({});
    vi.mocked(callContract).mockRejectedValueOnce(new LaunchBlocksError("HEDERA_CONTRACT_REVERT_EXECUTED", "reverted"));
    const failure = createSelfReleasingLock(offlineHederaContext(), {
      artifact,
      tokenId: "0.0.500",
      amount: "1000",
      beneficiary: "0.0.4242",
      lockSeconds: 60,
      runHbar: "3",
    });
    await expect(failure).rejects.toMatchObject({
      code: "HEDERA_CONTRACT_REVERT_EXECUTED",
      message: "Arming contract 0.0.700: reverted",
    });
    expect(order).toEqual(["deploy"]);
    expect(transferFungibleToken).not.toHaveBeenCalled();
  });
});

describe("createVestingSchedule()", () => {
  it("passes the schedule to the constructor and parks what its runs need", async () => {
    mockNetwork({
      pendingExpiry: 1792685009n,
      pendingSchedule: "0x0000000000000000000000000000000000a9d627",
      start: 1792685009n,
    });
    const result = await createVestingSchedule(offlineHederaContext(), {
      artifact: { contractName: "VestingSchedule" } as ContractArtifact,
      tokenId: "0.0.500",
      amount: "300",
      beneficiary: "0.0.9",
      startInSeconds: 150,
      intervalSeconds: 60,
      tranches: 3,
      scheduledGas: 2_500_000,
    });
    expect(vi.mocked(deployContract).mock.calls[0]![1]).toMatchObject({
      args: ["0.0.500", "0.0.9", 150, 60, 3, "0.0.4242", 2_500_000],
    });
    expect(vi.mocked(callContract).mock.calls[0]![1]).toMatchObject({ payableHbar: 4 });
    expect(result).toMatchObject({ firstTrancheAt: "2026-10-22T16:03:29.000Z", tranches: 3, runHbar: "4" });
  });
});
