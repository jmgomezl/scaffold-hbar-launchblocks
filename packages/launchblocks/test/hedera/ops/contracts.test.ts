import { ContractCreateFlow, ContractExecuteTransaction } from "@hiero-ledger/sdk";
import { encodeAbiParameters, encodeFunctionData, hexToBytes, parseAbiItem, toFunctionSelector, toHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContractArtifact } from "../../../src/contracts/types";
import { LaunchBlocksError } from "../../../src/errors";
import {
  callContract,
  deployContract,
  isReadOnly,
  parseFunctionSignature,
  toAbiValues,
  toEvmAddress,
} from "../../../src/hedera/ops/contracts";
import { offlineHederaContext } from "../../helpers/hedera";

afterEach(() => vi.restoreAllMocks());

const ALIAS = "0x8a2b3c4d5e6f708192a3b4c5d6e7f80910111213";

/** Mirror node: 0.0.7231440 is an alias-created account, 0.0.555 a contract, anything else unknown (a token). */
function mockMirror(read?: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/accounts/0.0.7231440")) return json({ account: "0.0.7231440", evm_address: ALIAS });
    if (url.includes("/accounts/0.0.555")) return json({ account: "0.0.555", evm_address: null });
    if (url.includes("/accounts/")) return json({ _status: { messages: [{ message: "Not found" }] } }, 404);
    if (url.includes("/blocks")) return json({ blocks: [{ timestamp: { to: String(Date.now() / 1000 + 5) } }] });
    if (url.endsWith("/contracts/call") && read !== undefined) {
      mockMirror.lastBody = JSON.parse(String(init?.body));
      return json({ result: read });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}
mockMirror.lastBody = undefined as unknown;

describe("toEvmAddress", () => {
  it("uses an account's EVM alias, and the long-zero form for tokens", async () => {
    mockMirror();
    const hedera = offlineHederaContext();
    await expect(toEvmAddress(hedera, "0.0.7231440")).resolves.toBe(ALIAS);
    await expect(toEvmAddress(hedera, "0.0.10674242")).resolves.toBe("0x0000000000000000000000000000000000a2e042");
    await expect(toEvmAddress(hedera, "0.0.555")).resolves.toBe("0x000000000000000000000000000000000000022b");
  });

  it("passes 0x addresses through without asking the mirror node", async () => {
    const spy = mockMirror();
    await expect(toEvmAddress(offlineHederaContext(), ALIAS.toUpperCase().replace("0X", "0x"))).resolves.toBe(ALIAS);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("toAbiValues", () => {
  const constructorInputs = [
    { name: "token_", type: "address" },
    { name: "beneficiary_", type: "address" },
    { name: "lockSeconds", type: "uint256" },
  ] as const;

  it("converts ids to addresses and numbers to bigints, for TokenLock's constructor", async () => {
    mockMirror();
    const values = await toAbiValues(offlineHederaContext(), constructorInputs, [
      "0.0.10674242",
      "0.0.7231440",
      "2592000",
    ]);
    expect(values).toEqual(["0x0000000000000000000000000000000000a2e042", ALIAS, 2592000n]);
  });

  it("names the expected parameters when the count is wrong", async () => {
    await expect(toAbiValues(offlineHederaContext(), constructorInputs, ["0.0.1"])).rejects.toThrow(
      "Expected 3 arguments (address token_, address beneficiary_, uint256 lockSeconds), got 1",
    );
  });

  it("refuses decimals for integers, since they are in smallest units", async () => {
    await expect(toAbiValues(offlineHederaContext(), [{ name: "amount", type: "uint256" }], ["1.5"])).rejects.toThrow(
      'argument "amount" (uint256): expected a whole number in smallest units, got "1.5"',
    );
  });

  it("parses booleans, strings, bytes and JSON arrays", async () => {
    mockMirror();
    const values = await toAbiValues(
      offlineHederaContext(),
      [
        { name: "flag", type: "bool" },
        { name: "label", type: "string" },
        { name: "data", type: "bytes" },
        { name: "amounts", type: "uint256[]" },
      ],
      ["true", 42, "0xabcd", "[1, 2]"],
    );
    expect(values).toEqual([true, "42", "0xabcd", [1n, 2n]]);
  });
});

describe("parseFunctionSignature", () => {
  it("accepts a Solidity signature with or without the function keyword", () => {
    expect(parseFunctionSignature("function lockedAmount() view returns (uint256)").name).toBe("lockedAmount");
    const release = parseFunctionSignature("release() returns (uint256)");
    expect(release.name).toBe("release");
    expect(isReadOnly(release)).toBe(false);
    expect(isReadOnly(parseFunctionSignature("lockedAmount() view returns (uint256)"))).toBe(true);
  });

  it("explains a signature it cannot parse", () => {
    expect(() => parseFunctionSignature("lockedAmount")).toThrow(LaunchBlocksError);
  });
});

describe("callContract", () => {
  it("reads view functions free through the mirror node and decodes the result", async () => {
    const raw = encodeAbiParameters([{ type: "uint256" }], [70710677118n]);
    mockMirror(raw);
    const execute = vi.spyOn(ContractExecuteTransaction.prototype, "execute");
    const result = await callContract(offlineHederaContext(), {
      contractId: "0.0.555",
      function: "function lockedAmount() view returns (uint256)",
    });
    expect(result).toMatchObject({ mode: "read", result: "70710677118", values: ["70710677118"], transactionId: null });
    expect(mockMirror.lastBody).toMatchObject({
      to: "0x000000000000000000000000000000000000022b",
      data: toFunctionSelector("function lockedAmount() view returns (uint256)"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("sends other functions as a transaction with the ABI-encoded call, and decodes its return", async () => {
    mockMirror();
    const sent: Uint8Array[] = [];
    vi.spyOn(ContractExecuteTransaction.prototype, "execute").mockImplementation(async function (
      this: ContractExecuteTransaction,
    ) {
      sent.push(this.functionParameters as Uint8Array);
      return {
        transactionId: { toString: () => "0.0.4242@1.2" },
        getRecord: async () => ({
          contractFunctionResult: {
            bytes: hexToBytes(encodeAbiParameters([{ type: "bool" }], [true])),
            gasUsed: 61234,
          },
        }),
      } as never;
    });
    const result = await callContract(offlineHederaContext(), {
      contractId: "0.0.555",
      function: "function transfer(address to, uint256 amount) returns (bool)",
      args: ["0.0.7231440", "500"],
    });
    const fn = parseAbiItem("function transfer(address to, uint256 amount) returns (bool)");
    expect(toHex(sent[0] as Uint8Array)).toBe(encodeFunctionData({ abi: [fn], args: [ALIAS, 500n] }));
    expect(result).toMatchObject({ mode: "write", result: "true", transactionId: "0.0.4242@1.2", gasUsed: 61234 });
  });
});

describe("deployContract", () => {
  const artifact: ContractArtifact = {
    contractName: "TokenLock",
    sourceName: "contracts/TokenLock.sol",
    abi: [
      {
        type: "constructor",
        stateMutability: "nonpayable",
        inputs: [
          { name: "token_", type: "address", internalType: "address" },
          { name: "beneficiary_", type: "address", internalType: "address" },
          { name: "lockSeconds", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    bytecode: "0x6080604052",
  };

  it("encodes the constructor arguments, sets token slots, and reports the new contract", async () => {
    mockMirror();
    const seen: ContractCreateFlow[] = [];
    vi.spyOn(ContractCreateFlow.prototype, "execute").mockImplementation(async function (this: ContractCreateFlow) {
      seen.push(this);
      return {
        transactionId: { toString: () => "0.0.4242@3.4" },
        getRecord: async () => ({
          receipt: { contractId: { toString: () => "0.0.6512600" } },
          contractFunctionResult: { gasUsed: 297662 },
        }),
      } as never;
    });
    const result = await deployContract(offlineHederaContext(), {
      artifact,
      args: ["0.0.10674242", "0.0.7231440", 2592000],
      autoAssociations: 1,
    });
    expect(result).toEqual({
      contract: "TokenLock",
      contractId: "0.0.6512600",
      accountId: "0.0.6512600",
      evmAddress: "0x0000000000000000000000000000000000635fd8",
      transactionId: "0.0.4242@3.4",
      gasUsed: 297662,
    });
    const flow = seen[0] as ContractCreateFlow;
    expect(toHex(flow.constructorParameters as Uint8Array)).toBe(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        ["0x0000000000000000000000000000000000a2e042", ALIAS, 2592000n],
      ),
    );
    expect(flow.maxAutomaticTokenAssociation).toBe(1);
    expect(flow.adminKey).toBeNull();
    // The flow uploads the bytecode as hex text; raw bytes fail with ERROR_DECODING_BYTESTRING.
    expect(new TextDecoder().decode(flow.bytecode as Uint8Array)).toBe("6080604052");
  });
});
