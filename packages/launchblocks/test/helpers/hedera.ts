import { PrivateKey } from "@hiero-ledger/sdk";

import { createHederaContext } from "../../src/hedera/client";
import type { HederaContext } from "../../src/hedera/context";

/** A real HederaContext with a throwaway key. Nothing here talks to a network. */
export function offlineHederaContext(): HederaContext {
  return createHederaContext({
    network: "testnet",
    operatorId: "0.0.4242",
    operatorKey: PrivateKey.generateED25519().toStringDer(),
  });
}
