/**
 * Check that this machine can run flows before anything is submitted.
 *
 *   yarn core:doctor [--env <path>] [--network <net>]
 *
 * Confirms the operator variables are set and parseable, that the account
 * exists on the selected network, and that it holds enough HBAR. Prints the
 * account id, network and balance — never the key.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

import { LaunchBlocksError } from "../src/errors";
import { ENV_VARS, hederaContextFromEnv, parseNetwork } from "../src/hedera/client";
import { hashscanUrl } from "../src/hedera/context";
import { fetchAccount, formatHbar } from "../src/hedera/mirror";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
/** A full launch flow costs well under 5 HBAR on testnet; warn below that. */
const RECOMMENDED_HBAR = 5n * 100_000_000n;

type Check = { label: string; ok: boolean; detail: string; hint?: string };

function report(checks: Check[]): void {
  for (const check of checks) {
    console.log(`${check.ok ? "✔" : "✖"} ${check.label}: ${check.detail}`);
    if (!check.ok && check.hint) console.log(`    → ${check.hint}`);
  }
}

function envPath(explicit: string | undefined): string | null {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(PACKAGE_ROOT, "..", "nextjs", ".env"), path.resolve(".env")];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const explicitEnv = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : undefined;
  const explicitNetwork = argv.includes("--network") ? argv[argv.indexOf("--network") + 1] : undefined;

  const checks: Check[] = [];
  const found = envPath(explicitEnv);
  if (found) {
    loadEnv({ path: found });
    checks.push({ label: "env file", ok: true, detail: path.relative(process.cwd(), found) || found });
  } else {
    checks.push({
      label: "env file",
      ok: false,
      detail: "not found",
      hint: "cp packages/nextjs/.env.example packages/nextjs/.env, then fill the operator variables.",
    });
  }

  for (const key of [ENV_VARS.operatorId, ENV_VARS.operatorKey] as const) {
    const value = process.env[key];
    checks.push({
      label: key,
      ok: Boolean(value),
      // Never print the key: only whether it is set, and its length.
      detail: value ? (key === ENV_VARS.operatorKey ? `set (${value.length} chars)` : value) : "missing",
      hint: `Set ${key} in your .env — get an account at https://portal.hedera.com`,
    });
  }

  if (!process.env[ENV_VARS.operatorId] || !process.env[ENV_VARS.operatorKey]) {
    report(checks);
    console.log("\nFix the items above, then run this again.");
    process.exitCode = 1;
    return;
  }

  const network = explicitNetwork ? parseNetwork(explicitNetwork) : parseNetwork(process.env[ENV_VARS.network]);
  let hedera;
  try {
    hedera = hederaContextFromEnv(process.env, { network });
    checks.push({ label: "operator key", ok: true, detail: "parsed" });
  } catch (error) {
    checks.push({
      label: "operator key",
      ok: false,
      detail: error instanceof LaunchBlocksError ? error.message : String(error),
      ...(error instanceof LaunchBlocksError && error.hint ? { hint: error.hint } : {}),
    });
    report(checks);
    process.exitCode = 1;
    return;
  }

  checks.push({
    label: "network",
    ok: network !== "mainnet",
    detail: network,
    hint: "This template is meant for testnet. Set HEDERA_NETWORK=testnet unless you really mean to spend real HBAR.",
  });

  try {
    const account = await fetchAccount(hedera, hedera.operatorId.toString());
    if (!account) {
      checks.push({
        label: "account",
        ok: false,
        detail: `${hedera.operatorId.toString()} does not exist on ${network}`,
        hint: `The id and key may belong to a different network. Create a ${network} account at https://portal.hedera.com`,
      });
    } else {
      const derived = hedera.operatorKey.publicKey.toStringRaw().toLowerCase();
      const onChain = account.publicKey?.toLowerCase().replace(/^0x/, "") ?? null;
      checks.push({
        label: "key matches account",
        ok: onChain === null || onChain === derived,
        detail:
          onChain === null
            ? "account key not exposed by the mirror node; skipped"
            : onChain === derived
              ? `yes (${account.keyType ?? "unknown curve"})`
              : "no — this key does not control this account",
        hint: `The key derives a different public key than ${account.accountId} holds. Check ${ENV_VARS.operatorKeyType} (ed25519 vs ecdsa) and that both values come from the same account.`,
      });

      const hbar = formatHbar(account.balanceTinybar);
      checks.push({
        label: "account",
        ok: !account.deleted,
        detail: `${account.accountId} exists on ${network}${account.keyType ? ` (${account.keyType})` : ""}`,
        hint: "The account is deleted; use another one.",
      });
      checks.push({
        label: "balance",
        ok: account.balanceTinybar >= RECOMMENDED_HBAR,
        detail: `${hbar} ℏ`,
        hint: `A launch flow needs a few HBAR. Top up at https://portal.hedera.com/faucet`,
      });
      console.log("");
      report(checks);
      console.log(`\naccount: ${hashscanUrl(network, "account", account.accountId)}`);
      const advisory = new Set(["balance", "network"]);
      const blocking = checks.filter(check => !check.ok && !advisory.has(check.label));
      console.log(
        blocking.length === 0
          ? "\nReady. Run a flow with: yarn core:run hts-launch-basic"
          : "\nFix the items above, then run this again.",
      );
      if (blocking.length > 0) process.exitCode = 1;
      return;
    }
  } catch (error) {
    checks.push({
      label: "mirror node",
      ok: false,
      detail: error instanceof LaunchBlocksError ? error.message : String(error),
      ...(error instanceof LaunchBlocksError && error.hint ? { hint: error.hint } : {}),
    });
  } finally {
    hedera.client.close();
  }

  console.log("");
  report(checks);
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
