import type { Signer } from "@hiero-ledger/sdk";
import { PublicKey } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";
import { MIRROR_BASE_URL, clientFor } from "./client";
import type { HederaContext, PythPriceUpdates } from "./context";
import { fetchAccount } from "./mirror";

export type WalletContextOptions = {
  /** A connected wallet, e.g. a hedera-wallet-connect DAppSigner. */
  signer: Signer;
  network: Network;
  mirrorBaseUrl?: string | undefined;
  /** Where Pyth price updates come from, e.g. the app's route, which holds the API key. */
  pythPriceUpdates?: PythPriceUpdates | undefined;
  signal?: AbortSignal;
};

/**
 * A context in which the connected wallet signs every transaction. The flow
 * gives the wallet account's public key to what it creates, so the key is
 * read from the mirror node: wallets do not hand it over (hedera-wallet-connect's
 * `getAccountKey` is not implemented). Accounts with a key list or a
 * threshold key are refused, since a single wallet cannot satisfy them.
 */
export async function walletHederaContext(options: WalletContextOptions): Promise<HederaContext> {
  const mirrorBaseUrl = (options.mirrorBaseUrl ?? MIRROR_BASE_URL[options.network]).replace(/\/+$/, "");
  const operatorId = options.signer.getAccountId();
  const account = await fetchAccount({ mirrorBaseUrl }, operatorId.toString(), options.signal);
  if (!account) {
    throw new LaunchBlocksError(
      "WALLET_ACCOUNT_NOT_FOUND",
      `Account ${operatorId.toString()} is not on ${options.network}`,
      {
        hint: `Connect a ${options.network} account in the wallet.`,
      },
    );
  }
  const operatorPublicKey = publicKeyOf(account.keyType, account.publicKey);
  if (!operatorPublicKey) {
    throw new LaunchBlocksError(
      "WALLET_KEY_UNSUPPORTED",
      `Account ${operatorId.toString()} has a key list or threshold key, which one wallet cannot sign for`,
      { hint: "Connect an account with a single ED25519 or ECDSA key." },
    );
  }
  return {
    network: options.network,
    client: clientFor(options.network),
    operatorId,
    operatorPublicKey,
    signer: options.signer,
    mirrorBaseUrl,
    ...(options.pythPriceUpdates ? { pythPriceUpdates: options.pythPriceUpdates } : {}),
  };
}

function publicKeyOf(type: string | null, hex: string | null): PublicKey | null {
  if (!hex) return null;
  if (type === "ED25519") return PublicKey.fromStringED25519(hex);
  if (type === "ECDSA_SECP256K1") return PublicKey.fromStringECDSA(hex);
  return null;
}
