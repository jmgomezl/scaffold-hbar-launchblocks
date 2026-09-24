import type { TokenMintTransaction } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import type { LaunchBlocksError } from "../../../src/errors";
import { MAX_SCHEDULE_DELAY_SECONDS, buildSchedule } from "../../../src/hedera/ops/schedules";
import { buildTokenMint } from "../../../src/hedera/ops/tokens";
import { hssScheduleMint, hssScheduleTransfer } from "../../../src/steps";
import { offlineHederaContext } from "../../helpers/hedera";

const NOW = Date.parse("2026-09-23T05:00:00.000Z");

function mint(): TokenMintTransaction {
  return buildTokenMint({ tokenId: "0.0.10676025", amount: "1000" }, 8);
}

describe("buildSchedule", () => {
  it("waits for its expiration time, so the network runs it then (HIP-423)", () => {
    const { transaction, executesAt } = buildSchedule(offlineHederaContext(), mint(), { delaySeconds: 2592000 }, NOW);
    expect(executesAt.toISOString()).toBe("2026-10-23T05:00:00.000Z");
    expect(transaction.waitForExpiry).toBe(true);
    expect(transaction.expirationTime?.toDate().toISOString()).toBe("2026-10-23T05:00:00.000Z");
    expect(transaction.adminKey).toBeNull();
  });

  it("gives the schedule the operator's key only when asked, so it can be cancelled", () => {
    const hedera = offlineHederaContext();
    const { transaction } = buildSchedule(hedera, mint(), { delaySeconds: 60, adminKey: true, memo: "unlock" }, NOW);
    expect(transaction.adminKey?.toString()).toBe(hedera.operatorPublicKey.toString());
    expect(transaction.getScheduleMemo).toBe("unlock");
  });

  it("refuses delays the network would reject", () => {
    const code = (delaySeconds: number) => {
      try {
        buildSchedule(offlineHederaContext(), mint(), { delaySeconds }, NOW);
      } catch (error) {
        return (error as LaunchBlocksError).code;
      }
      return undefined;
    };
    expect(code(0)).toBe("SCHEDULE_DELAY_INVALID");
    expect(code(1.5)).toBe("SCHEDULE_DELAY_INVALID");
    expect(code(MAX_SCHEDULE_DELAY_SECONDS)).toBeUndefined();
    expect(code(MAX_SCHEDULE_DELAY_SECONDS + 1)).toBe("SCHEDULE_TOO_FAR");
  });
});

describe("schedule steps", () => {
  it("cap the delay at 62 days in validation too", () => {
    const base = { tokenId: "0.0.5", amount: "10" };
    expect(hssScheduleMint.input.safeParse({ ...base, delaySeconds: 5356800 }).success).toBe(true);
    expect(hssScheduleMint.input.safeParse({ ...base, delaySeconds: 5356801 }).success).toBe(false);
    expect(hssScheduleTransfer.input.safeParse({ ...base, to: "0.0.7", delaySeconds: 60 }).data).toMatchObject({
      adminKey: false,
    });
  });
});
