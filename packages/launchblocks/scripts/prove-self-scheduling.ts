/**
 * Testnet proof that the self-scheduling blocks work end to end (HIP-1215), through the same
 * operations the Lock and Vest blocks run: a SelfReleasingLock released 3 minutes after it is
 * deployed, and a VestingSchedule paying 3 tranches a minute apart from 2.5 minutes on. Each is
 * deployed (as an Ethereum transaction when the operator has an ECDSA alias), armed and funded
 * with a token the operator holds; the network then runs them by itself.
 *
 *   npx tsx scripts/prove-self-scheduling.ts <tokenId> <out.json>
 *
 * Spends testnet HBAR: two deployments, two arm calls, two token transfers, and the scheduled runs,
 * paid from the HBAR parked in each contract (the rest comes back after the last run). Reads the
 * operator from packages/nextjs/.env; prints no key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadHardhatArtifact } from "../src/contracts/artifacts";
import { hederaContextFromEnv } from "../src/hedera/client";
import { createSelfReleasingLock, createVestingSchedule } from "../src/hedera/ops/self-scheduling";

const [tokenId, out] = process.argv.slice(2);
if (!tokenId || !out) throw new Error("usage: prove-self-scheduling.ts <tokenId> <out.json>");

// Last value wins, as with dotenv; nothing from this file is printed.
const env: Record<string, string> = {};
for (const line of readFileSync(path.join(__dirname, "../../nextjs/.env"), "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && match[2]) env[match[1]!] = match[2].replace(/^"|"$/g, "");
}
const hedera = hederaContextFromEnv(env);
if (hedera.network !== "testnet") throw new Error("this proof runs on testnet only");
const operator = hedera.operatorId.toString();

(async () => {
  const proof: Record<string, unknown> = { network: "testnet", tokenId, operator, startedAt: new Date().toISOString() };

  const lock = await createSelfReleasingLock(hedera, {
    artifact: loadHardhatArtifact("SelfReleasingLock"),
    tokenId,
    amount: "1000",
    beneficiary: operator,
    lockSeconds: 180,
  });
  console.log("lock", lock.contractId, "releases at", lock.releaseAt, "schedule", lock.scheduleId);
  proof.lock = lock;

  const vesting = await createVestingSchedule(hedera, {
    artifact: loadHardhatArtifact("VestingSchedule"),
    tokenId,
    amount: "300",
    beneficiary: operator,
    startInSeconds: 150,
    intervalSeconds: 60,
    tranches: 3,
  });
  console.log(
    "vesting",
    vesting.contractId,
    "first tranche at",
    vesting.firstTrancheAt,
    "schedule",
    vesting.scheduleId,
  );
  proof.vesting = vesting;

  writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log("proof saved to", out);
  hedera.client.close();
  process.exit(0);
})().catch(error => {
  console.error(
    "FAILED:",
    error instanceof Error ? `${error.message}${"hint" in error ? ` (${String(error.hint)})` : ""}` : error,
  );
  process.exit(1);
});
