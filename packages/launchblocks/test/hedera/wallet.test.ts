import type { Signer } from "@hiero-ledger/sdk";
import {
  AccountId,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
  TopicCreateTransaction,
  Transaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import { concat, encodeAbiParameters, hexToBytes, toHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContractArtifact } from "../../src/contracts/types";
import { LaunchBlocksError } from "../../src/errors";
import type { HederaContext } from "../../src/hedera/context";
import { deployContract } from "../../src/hedera/ops/contracts";
import { send, sendContract } from "../../src/hedera/ops/submit";
import { airdropFungibleToken, getTokenInfo } from "../../src/hedera/ops/tokens";
import { submitTopicMessage } from "../../src/hedera/ops/topics";
import { walletHederaContext } from "../../src/hedera/wallet";

afterEach(() => vi.restoreAllMocks());

const WALLET_ACCOUNT = "0.0.7231440";
const KEY = PrivateKey.generateECDSA();

/** A stand-in for a hedera-wallet-connect DAppSigner: only what the context reads. */
const fakeSigner = { getAccountId: () => AccountId.fromString(WALLET_ACCOUNT) } as unknown as Signer;

type Json = Record<string, unknown>;
function mockMirror(routes: Record<string, Json | null>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = String(input);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    const [, body] = hit;
    return new Response(JSON.stringify(body ?? { _status: "not found" }), {
      status: body ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  });
}

async function walletContext(): Promise<HederaContext> {
  mockMirror({
    [`/accounts/${WALLET_ACCOUNT}`]: {
      account: WALLET_ACCOUNT,
      key: { _type: "ECDSA_SECP256K1", key: KEY.publicKey.toStringRaw() },
    },
  });
  const hedera = await walletHederaContext({ signer: fakeSigner, network: "testnet" });
  vi.restoreAllMocks();
  return hedera;
}

/** Make executeWithSigner succeed without a network, and capture what the wallet was asked to sign. */
function fakeWalletExecution(receipt: Json = {}) {
  const signed: Transaction[] = [];
  vi.spyOn(Transaction.prototype, "executeWithSigner").mockImplementation(async function (this: Transaction) {
    signed.push(this);
    return {
      transactionId: this.transactionId,
      getReceipt: async () => ({ status: { toString: () => "SUCCESS" }, ...receipt }),
    } as never;
  });
  const operatorExecute = vi.spyOn(Transaction.prototype, "execute");
  return { signed, operatorExecute };
}

describe("walletHederaContext", () => {
  it("takes the wallet account's key from the mirror node and keeps no private key", async () => {
    const hedera = await walletContext();
    expect(hedera.operatorId.toString()).toBe(WALLET_ACCOUNT);
    expect(hedera.operatorPublicKey.toStringRaw()).toBe(KEY.publicKey.toStringRaw());
    expect(hedera.signer).toBe(fakeSigner);
    expect(hedera.operatorKey).toBeUndefined();
    expect(hedera.client.operatorAccountId).toBeNull();
  });

  it("refuses key lists, which one wallet cannot sign for, and unknown accounts", async () => {
    mockMirror({
      [`/accounts/${WALLET_ACCOUNT}`]: { account: WALLET_ACCOUNT, key: { _type: "ProtobufEncoded", key: "0a" } },
    });
    await expect(walletHederaContext({ signer: fakeSigner, network: "testnet" })).rejects.toMatchObject({
      code: "WALLET_KEY_UNSUPPORTED",
    });
    vi.restoreAllMocks();
    mockMirror({ [`/accounts/${WALLET_ACCOUNT}`]: null });
    await expect(walletHederaContext({ signer: fakeSigner, network: "testnet" })).rejects.toMatchObject({
      code: "WALLET_ACCOUNT_NOT_FOUND",
    });
  });
});

describe("send with a wallet", () => {
  it("freezes for the wallet account and has the wallet sign and submit, never the client", async () => {
    const hedera = await walletContext();
    const { signed, operatorExecute } = fakeWalletExecution({ topicId: { toString: () => "0.0.99" } });
    const sent = await send(hedera, new TopicCreateTransaction(), "Creating topic");
    const [transaction] = signed;
    expect(transaction?.isFrozen()).toBe(true);
    expect(transaction?.transactionId?.accountId?.toString()).toBe(WALLET_ACCOUNT);
    expect(sent.transactionId).toBe(transaction?.transactionId?.toString());
    expect(operatorExecute).not.toHaveBeenCalled();
  });

  it("reads contract results from the mirror node instead of a paid record query", async () => {
    const hedera = await walletContext();
    fakeWalletExecution();
    const output = encodeAbiParameters([{ type: "uint256" }], [42n]);
    mockMirror({ "/contracts/results/": { call_result: output, gas_used: 46615 } });
    const outcome = await sendContract(
      hedera,
      new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.5")).setGas(100_000),
      "Calling",
    );
    expect(outcome).toMatchObject({ output, gasUsed: 46615 });
  });
});

describe("operations with a wallet", () => {
  it("read token metadata from the mirror node", async () => {
    const hedera = await walletContext();
    const tokenQuery = vi.spyOn(Transaction.prototype, "execute");
    mockMirror({
      "/tokens/0.0.77": { token_id: "0.0.77", name: "Demo", symbol: "DMO", decimals: "8", total_supply: "100" },
    });
    await expect(getTokenInfo(hedera, "0.0.77")).resolves.toMatchObject({ decimals: 8, symbol: "DMO" });
    expect(tokenQuery).not.toHaveBeenCalled();
  });

  it("count pending airdrops from who the mirror node shows receiving", async () => {
    const hedera = await walletContext();
    fakeWalletExecution();
    mockMirror({
      "/tokens/0.0.77": { token_id: "0.0.77", name: "Demo", symbol: "DMO", decimals: "0", total_supply: "100" },
      "/transactions/": {
        transactions: [
          {
            token_transfers: [
              { token_id: "0.0.77", account: WALLET_ACCOUNT, amount: -10 },
              { token_id: "0.0.77", account: "0.0.800", amount: 10 },
            ],
          },
        ],
      },
    });
    const result = await airdropFungibleToken(hedera, {
      tokenId: "0.0.77",
      recipients: [
        { accountId: "0.0.800", amount: 10 },
        { accountId: "0.0.801", amount: 10 },
      ],
    });
    expect(result.pendingCount).toBe(1);
  });

  it("refuse a topic message that would need several chunks, one approval each", async () => {
    const hedera = await walletContext();
    await expect(
      submitTopicMessage(hedera, { topicId: "0.0.9", message: "x".repeat(1025), maxChunks: 2 }),
    ).rejects.toMatchObject({ code: "WALLET_MESSAGE_TOO_LONG" });
  });

  it("deploy a small contract in one transaction, constructor arguments appended to the bytecode", async () => {
    const hedera = await walletContext();
    const { signed } = fakeWalletExecution({ contractId: ContractId.fromString("0.0.500") });
    mockMirror({
      "/accounts/": { account: "0.0.600", evm_address: null },
      "/contracts/results/": { call_result: "0x", gas_used: 297434 },
    });
    const artifact: ContractArtifact = {
      contractName: "Box",
      sourceName: "contracts/Box.sol",
      abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "value", type: "uint256" }] }],
      bytecode: "0x6080604052",
    };
    const result = await deployContract(hedera, { artifact, args: ["7"], autoAssociations: 1 });
    const [create] = signed;
    expect(create).toBeInstanceOf(ContractCreateTransaction);
    const expected = concat([hexToBytes("0x6080604052"), hexToBytes(encodeAbiParameters([{ type: "uint256" }], [7n]))]);
    expect(toHex((create as ContractCreateTransaction).bytecode as Uint8Array)).toBe(toHex(expected));
    expect(result).toMatchObject({ contractId: "0.0.500", gasUsed: 297434 });
  });
});

describe("error handling with a wallet", () => {
  it("reports a failed receipt as a translated Hedera error", async () => {
    const hedera = await walletContext();
    vi.spyOn(Transaction.prototype, "executeWithSigner").mockImplementation(async function (this: Transaction) {
      return {
        transactionId: this.transactionId ?? TransactionId.generate(WALLET_ACCOUNT),
        getReceipt: async () => {
          throw Object.assign(new Error("receipt for transaction contained error status CONTRACT_REVERT_EXECUTED"), {
            status: { toString: () => "CONTRACT_REVERT_EXECUTED" },
          });
        },
      } as never;
    });
    const error = await send(hedera, new TopicCreateTransaction(), "Creating topic").catch(e => e);
    expect(error).toBeInstanceOf(LaunchBlocksError);
    expect(String(error.message)).toMatch(/Creating topic/);
  });

  /** A failed request as DAppSigner reports it: one Error wrapping JSON with both attempts and their stacks. */
  function dappSignerFailure(walletError: Json) {
    return new Error(
      "Error executing transaction or query: \n" +
        JSON.stringify(
          {
            txError: { name: undefined, stack: undefined, ...walletError },
            queryError: {
              name: "Error",
              message: "Unsupported query type",
              stack: "Error: Unsupported query type\n    at …",
            },
          },
          null,
          2,
        ),
    );
  }

  async function failWith(error: unknown) {
    const hedera = await walletContext();
    vi.spyOn(Transaction.prototype, "executeWithSigner").mockRejectedValue(error);
    return send(hedera, new TopicCreateTransaction(), "Creating topic").catch(e => e);
  }

  it("reports a transaction declined in the wallet, without the signer's stack traces", async () => {
    const error = await failWith(dappSignerFailure({ message: "User rejected the request.", code: 5000 }));
    expect(error).toMatchObject({ code: "WALLET_REJECTED", message: "Creating topic: declined in the wallet" });
    expect(error.hint).toMatch(/approve/);
  });

  it("reads a network status out of the wallet's message, with a hint about the wallet account", async () => {
    const error = await failWith(
      dappSignerFailure({ message: "transaction failed precheck with status INSUFFICIENT_PAYER_BALANCE" }),
    );
    expect(error).toMatchObject({ code: "HEDERA_INSUFFICIENT_PAYER_BALANCE" });
    expect(error.hint).toMatch(/wallet account/);
  });

  it("asks to reconnect when the wallet session is gone", async () => {
    const error = await failWith({ message: "Session no longer exists. Please reconnect to the wallet." });
    expect(error).toMatchObject({ code: "WALLET_DISCONNECTED" });
    expect(String(error.message)).not.toMatch(/queryError|stack/);
  });
});
