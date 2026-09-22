import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";
import { NetworkSchema } from "../flow/schema";
import type { HederaContext } from "./context";

export const MIRROR_BASE_URL: Record<Network, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
  localnet: "http://localhost:5551",
};

export type OperatorKeyType = "ed25519" | "ecdsa";

export type HederaContextOptions = {
  network: Network;
  operatorId: string;
  operatorKey: string;
  /** Only needed for raw hex keys, which do not encode their curve. DER keys are self-describing. */
  operatorKeyType?: OperatorKeyType | undefined;
  mirrorBaseUrl?: string | undefined;
};

/** Build the SDK client and operator identity a run needs. Never logs the key. */
export function createHederaContext(options: HederaContextOptions): HederaContext {
  const operatorId = parseAccountId(options.operatorId);
  const operatorKey = parsePrivateKey(options.operatorKey, options.operatorKeyType);
  const client = clientFor(options.network).setOperator(operatorId, operatorKey);
  return {
    network: options.network,
    client,
    operatorId,
    operatorKey,
    mirrorBaseUrl: (options.mirrorBaseUrl ?? MIRROR_BASE_URL[options.network]).replace(/\/+$/, ""),
  };
}

export const ENV_VARS = {
  network: "HEDERA_NETWORK",
  operatorId: "HEDERA_OPERATOR_ID",
  operatorKey: "HEDERA_OPERATOR_KEY",
  operatorKeyType: "HEDERA_OPERATOR_KEY_TYPE",
  mirrorBaseUrl: "HEDERA_MIRROR_URL",
} as const;

/**
 * Read the operator from environment variables (see `.env.example`).
 * `network` defaults to `HEDERA_NETWORK`, then testnet.
 */
export function hederaContextFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<HederaContextOptions> = {},
): HederaContext {
  const network = overrides.network ?? parseNetwork(env[ENV_VARS.network]);
  const operatorId = overrides.operatorId ?? env[ENV_VARS.operatorId];
  const operatorKey = overrides.operatorKey ?? env[ENV_VARS.operatorKey];
  if (!operatorId || !operatorKey) {
    throw new LaunchBlocksError(
      "OPERATOR_MISSING",
      `Set ${ENV_VARS.operatorId} and ${ENV_VARS.operatorKey} (create a ${network} account at https://portal.hedera.com)`,
    );
  }
  return createHederaContext({
    network,
    operatorId,
    operatorKey,
    operatorKeyType: overrides.operatorKeyType ?? parseKeyType(env[ENV_VARS.operatorKeyType]),
    mirrorBaseUrl: overrides.mirrorBaseUrl ?? env[ENV_VARS.mirrorBaseUrl],
  });
}

export function parseNetwork(value: string | undefined): Network {
  if (value === undefined || value === "") return "testnet";
  const parsed = NetworkSchema.safeParse(value.toLowerCase());
  if (!parsed.success) {
    throw new LaunchBlocksError("NETWORK_INVALID", `${ENV_VARS.network} must be one of testnet, mainnet, localnet`);
  }
  return parsed.data;
}

function parseKeyType(value: string | undefined): OperatorKeyType | undefined {
  if (value === undefined || value === "") return undefined;
  const lowered = value.toLowerCase();
  if (lowered === "ed25519" || lowered === "ecdsa") return lowered;
  throw new LaunchBlocksError("KEY_TYPE_INVALID", `${ENV_VARS.operatorKeyType} must be ed25519 or ecdsa`);
}

export function parseAccountId(value: string): AccountId {
  try {
    return AccountId.fromString(value.trim());
  } catch (cause) {
    throw new LaunchBlocksError("OPERATOR_ID_INVALID", `Operator id "${value}" is not a valid account id (0.0.x)`, {
      cause,
    });
  }
}

/**
 * Accepts DER-encoded keys (as issued by the Hedera Portal) and raw hex keys.
 * Raw hex keys need `type` because ED25519 and ECDSA secp256k1 keys are both 32 bytes.
 */
export function parsePrivateKey(value: string, type?: OperatorKeyType): PrivateKey {
  const raw = value.trim().replace(/^0x/i, "");
  try {
    if (type === "ecdsa") return PrivateKey.fromStringECDSA(raw);
    if (type === "ed25519") return PrivateKey.fromStringED25519(raw);
    return PrivateKey.fromString(raw);
  } catch (cause) {
    throw new LaunchBlocksError(
      "OPERATOR_KEY_INVALID",
      `Operator key is not a valid ${type ?? "DER or hex"} private key` +
        (type ? "" : `; for raw hex keys set ${ENV_VARS.operatorKeyType}=ed25519|ecdsa`),
      { cause },
    );
  }
}

function clientFor(network: Network): Client {
  switch (network) {
    case "testnet":
      return Client.forTestnet();
    case "mainnet":
      return Client.forMainnet();
    case "localnet":
      return Client.forNetwork({ "127.0.0.1:50211": new AccountId(3) }).setMirrorNetwork("127.0.0.1:5600");
  }
}
