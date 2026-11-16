import {
  ContractCreateFlow,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractId,
  EthereumTransaction,
  EthereumTransactionDataEip1559,
  Hbar,
} from "@hiero-ledger/sdk";
import type { AbiFunction, AbiParameter } from "viem";
import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  hexToBytes,
  parseAbiItem,
  toHex,
} from "viem";

import type { ContractArtifact } from "../../contracts/types";
import { LaunchBlocksError } from "../../errors";
import type { Network } from "../../flow/schema";
import { entityIdToEvmAddress } from "../abi";
import type { DecimalAmount } from "../amounts";
import { toLong, toUnits } from "../amounts";
import type { HederaContext } from "../context";
import { HederaError, translateHederaError, translateWalletError } from "../errors";
import {
  estimateGas,
  fetchAccount,
  fetchContractResult,
  fetchGasPriceTinybar,
  readContract,
  waitForMirror,
} from "../mirror";
import { send, sendContract } from "./submit";

/** Measured: deploying TokenLock used well under this on testnet. Hedera charges at least 80% of the limit. */
export const DEFAULT_DEPLOY_GAS = 1_000_000;
export const DEFAULT_CALL_GAS = 400_000;

const ENTITY_ID = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ── Arguments ───────────────────────────────────────────────────────────────

/**
 * The EVM address for an account, token or contract given as `0.0.x` or
 * `0x…`. Accounts and contracts with an EVM address use it: an alias-created
 * ECDSA account rejects its long-zero form as a token recipient. Tokens are
 * not accounts and keep the long-zero form, where their ERC-20 facade lives.
 */
export async function toEvmAddress(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  value: string,
  signal?: AbortSignal,
): Promise<`0x${string}`> {
  const text = value.trim();
  if (EVM_ADDRESS.test(text)) return text.toLowerCase() as `0x${string}`;
  if (!ENTITY_ID.test(text)) {
    throw new LaunchBlocksError("CONTRACT_ARG_INVALID", `"${value}" is not an address, account, token or contract id`);
  }
  const account = await fetchAccount(hedera, text, signal);
  return (account?.evmAddress ?? entityIdToEvmAddress(text)) as `0x${string}`;
}

/** Convert one flow value to what the ABI coder expects for `param`. */
async function toAbiValue(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  param: AbiParameter,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const where = param.name ? `argument "${param.name}" (${param.type})` : `a ${param.type} argument`;
  const fail = (why: string) => new LaunchBlocksError("CONTRACT_ARG_INVALID", `${where}: ${why}`);
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array) {
    const items: unknown = typeof value === "string" ? safeJson(value) : value;
    if (!Array.isArray(items)) throw fail("expected a JSON array");
    const item = { ...param, type: array[1] as string } as AbiParameter;
    return Promise.all(items.map(entry => toAbiValue(hedera, item, entry, signal)));
  }
  if (param.type === "tuple") {
    const components = "components" in param ? param.components : [];
    const fields: unknown = typeof value === "string" ? safeJson(value) : value;
    if (Array.isArray(fields)) {
      return Promise.all(components.map((component, index) => toAbiValue(hedera, component, fields[index], signal)));
    }
    if (fields === null || typeof fields !== "object") throw fail("expected a JSON object or array");
    const entries = await Promise.all(
      components.map(
        async component =>
          [
            component.name,
            await toAbiValue(hedera, component, (fields as Record<string, unknown>)[component.name ?? ""], signal),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
  if (value === undefined || value === null || value === "") throw fail("missing");
  if (param.type === "address") return toEvmAddress(hedera, String(value), signal);
  if (/^u?int\d*$/.test(param.type)) {
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) throw fail(`expected a whole number in smallest units, got "${text}"`);
    return BigInt(text);
  }
  if (param.type === "bool") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw fail(`expected true or false, got "${String(value)}"`);
  }
  if (param.type === "string") return String(value);
  if (/^bytes\d*$/.test(param.type)) {
    const text = String(value).trim();
    if (!/^0x([0-9a-fA-F]{2})*$/.test(text)) throw fail("expected 0x-prefixed hex");
    return text;
  }
  throw fail("this type is not supported by the block");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function toAbiValues(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  params: readonly AbiParameter[],
  args: readonly unknown[],
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (args.length !== params.length) {
    const expected = params.map(param => `${param.type}${param.name ? ` ${param.name}` : ""}`).join(", ");
    throw new LaunchBlocksError(
      "CONTRACT_ARGS_COUNT",
      `Expected ${params.length} argument${params.length === 1 ? "" : "s"} (${expected || "none"}), got ${args.length}`,
    );
  }
  return Promise.all(params.map((param, index) => toAbiValue(hedera, param, args[index], signal)));
}

/** Decoded values made JSON-safe: bigints become decimal strings. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

/** One return value as itself (as a string), several as a JSON array. */
function renderResult(values: unknown[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const only = values[0];
    return typeof only === "string" ? only : JSON.stringify(only);
  }
  return JSON.stringify(values);
}

// ── Signatures ──────────────────────────────────────────────────────────────

/**
 * Parse a Solidity function signature, e.g.
 * `function lockedAmount() view returns (uint256)`; the leading `function`
 * is optional.
 */
export function parseFunctionSignature(signature: string): AbiFunction {
  const text = signature.trim().replace(/;$/, "");
  let item: ReturnType<typeof parseAbiItem>;
  try {
    item = parseAbiItem(text.startsWith("function ") ? text : `function ${text}`);
  } catch (cause) {
    throw new LaunchBlocksError("CONTRACT_SIGNATURE_INVALID", `"${signature}" is not a function signature`, {
      cause,
      hint: "Write it as in Solidity, e.g. function lockedAmount() view returns (uint256).",
    });
  }
  if (item.type !== "function") {
    throw new LaunchBlocksError("CONTRACT_SIGNATURE_INVALID", `"${signature}" is not a function signature`);
  }
  return item;
}

export function isReadOnly(fn: AbiFunction): boolean {
  return fn.stateMutability === "view" || fn.stateMutability === "pure";
}

// ── Deploy ──────────────────────────────────────────────────────────────────

export type DeployContractParams = {
  artifact: ContractArtifact;
  /** Constructor arguments, in order. */
  args?: readonly unknown[] | undefined;
  gas?: number | undefined;
  /** Token association slots, so the contract can receive HTS tokens; -1 is unlimited. */
  autoAssociations?: number | undefined;
  /** Give the contract the operator's key as admin key; without one it can never be updated or deleted. */
  adminKey?: boolean | undefined;
  /** HBAR to send to the contract at creation (its constructor must be payable). */
  initialHbar?: DecimalAmount | undefined;
  memo?: string | undefined;
};

export type DeployContractResult = {
  contract: string;
  contractId: string;
  /** The same entity as an account: contracts can hold HBAR and tokens. */
  accountId: string;
  evmAddress: string;
  transactionId: string;
  gasUsed: number;
};

/** Bytecode that fits a single ContractCreate transaction (Hedera caps transactions at 6 KB). */
export const INLINE_BYTECODE_LIMIT = 4096;

/**
 * Initcode that fits one Ethereum transaction under the same 6 KB cap, with room for the envelope and
 * signatures, so the deploy does not depend on jumbo transactions (HIP-1086) being enabled.
 */
export const ETHEREUM_DEPLOY_LIMIT = 5120;

/** EIP-155 chain ids of the Hedera networks (HIP-26). */
const CHAIN_ID: Record<Network, number> = { mainnet: 295, testnet: 296, localnet: 298 };

/** One HBAR is 10^8 tinybars; the EVM counts value and gas prices in weibars, 10^18 per HBAR. */
const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** Headroom over the mirror node's gas estimate, and over the gas price in case it rises before consensus. */
const GAS_HEADROOM = 1.2;

/**
 * One Ethereum deploy at a time per operator, in this process, so two runs never sign the same
 * nonce. Another process sharing the operator can still collide; that is retried once.
 */
const ethereumQueues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (ethereumQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  ethereumQueues.set(key, next);
  return next;
}

/**
 * The operator's EVM address when it can send an Ethereum transaction: an operator context, an
 * ECDSA key, and an account the network finds by the address that key derives (an account created
 * from its ECDSA alias, as the portal creates them). Anything else deploys with ContractCreate.
 */
async function ethereumSender(hedera: HederaContext, signal?: AbortSignal): Promise<`0x${string}` | null> {
  const key = hedera.operatorKey;
  if (hedera.signer || !key || key.type !== "secp256k1") return null;
  const address = `0x${key.publicKey.toEvmAddress()}`.toLowerCase() as `0x${string}`;
  const account = await fetchAccount(hedera, hedera.operatorId.toString(), signal);
  return account?.evmAddress?.toLowerCase() === address ? address : null;
}

/**
 * Deploy `initcode` as an Ethereum transaction signed with the operator's ECDSA key. Hedera charges
 * it gas only: no ContractCreate fee (about $1) and no file storage, so a TokenLock costs about 0.35
 * HBAR on testnet instead of about 15. The gas limit is the mirror node's estimate plus headroom,
 * never above `maxGas`.
 */
async function deployAsEthereumTransaction(
  hedera: HederaContext,
  from: `0x${string}`,
  args: { initcode: Uint8Array; maxGas: number; valueTinybar: bigint; context: string },
  signal?: AbortSignal,
): Promise<{ contractId: string; evmAddress: string; transactionId: string; gasUsed: number }> {
  const key = hedera.operatorKey!;
  const estimate = await estimateGas(
    hedera,
    { from, data: toHex(args.initcode), ...(args.valueTinybar ? { value: args.valueTinybar } : {}) },
    signal,
  );
  if (estimate > args.maxGas) {
    throw new LaunchBlocksError(
      "CONTRACT_GAS_TOO_LOW",
      `${args.context} needs about ${estimate.toLocaleString("en-US")} gas; the limit is ${args.maxGas.toLocaleString("en-US")}`,
      { hint: "Raise the step's gas limit." },
    );
  }
  const gasLimit = Math.min(Math.ceil(estimate * GAS_HEADROOM), args.maxGas);
  const priceTinybar = await fetchGasPriceTinybar(hedera, signal);

  const attempt = async () => {
    const nonce = (await fetchAccount(hedera, hedera.operatorId.toString(), signal))?.ethereumNonce ?? 0;
    const data = new EthereumTransactionDataEip1559({
      chainId: new Uint8Array(),
      nonce: new Uint8Array(),
      maxPriorityGas: new Uint8Array(),
      maxGas: new Uint8Array(),
      gasLimit: new Uint8Array(),
      to: new Uint8Array(),
      value: new Uint8Array(),
      callData: args.initcode,
      accessList: [],
      recId: new Uint8Array(),
      r: new Uint8Array(),
      s: new Uint8Array(),
    })
      .setChainId(CHAIN_ID[hedera.network])
      .setNonce(nonce)
      .setMaxPriorityGas(0)
      .setMaxGas(BigInt(Math.ceil(priceTinybar * GAS_HEADROOM)) * WEIBAR_PER_TINYBAR)
      .setGasLimit(gasLimit)
      .setValue(args.valueTinybar * WEIBAR_PER_TINYBAR)
      .sign(key);
    // The operator is both the sender and the payer, so the allowance only matters if the price rises.
    const transaction = new EthereumTransaction()
      .setEthereumData(data)
      .setMaxGasAllowanceHbar(Hbar.fromTinybars(gasLimit * priceTinybar));
    const { transactionId, receipt } = await send(hedera, transaction, args.context);
    return { nonce, transactionId, contractId: receipt.contractId?.toString() };
  };

  const sent = await oneAtATime(hedera.operatorId.toString(), async () => {
    try {
      return await attempt();
    } catch (error) {
      // Another process sent an Ethereum transaction with the same nonce first: read it again.
      if (error instanceof HederaError && error.status === "WRONG_NONCE") return attempt();
      throw error;
    }
  });
  if (!sent.contractId) throw new LaunchBlocksError("CONTRACT_NO_ID", "The deployment returned no contract id");
  // Free, unlike a record, and it waits for the mirror node, so the next deploy reads the new nonce.
  const { gasUsed } = await fetchContractResult(hedera, sent.transactionId, signal ? { signal } : {});
  return {
    contractId: sent.contractId,
    evmAddress: getContractAddress({ from, nonce: BigInt(sent.nonce) }).toLowerCase(),
    transactionId: sent.transactionId,
    gasUsed,
  };
}

/**
 * An Ethereum transaction cannot set token slots: Hedera gives the contracts it creates unlimited
 * ones (observed on testnet). Confirm that before anything sends the contract tokens.
 */
async function checkTokenSlots(
  hedera: HederaContext,
  contractId: string,
  wanted: number,
  signal?: AbortSignal,
): Promise<void> {
  if (wanted === 0) return;
  const slots = (await fetchAccount(hedera, contractId, signal))?.maxAutoAssociations ?? 0;
  if (slots === -1 || (wanted !== -1 && slots >= wanted)) return;
  throw new LaunchBlocksError(
    "CONTRACT_NO_TOKEN_SLOTS",
    `Contract ${contractId} was deployed with ${slots} token slots, fewer than the ${wanted === -1 ? "unlimited" : wanted} asked for`,
    { hint: "Do not send it tokens it has no slot for. A deploy with a memo uses ContractCreate, which sets slots." },
  );
}

/**
 * Deploy a compiled contract. An operator with an ECDSA alias account sends it
 * as one Ethereum transaction, which costs gas only (see
 * {@link deployAsEthereumTransaction}), unless it needs an admin key or a memo,
 * which only ContractCreate can set, or its initcode is over
 * {@link ETHEREUM_DEPLOY_LIMIT}. Otherwise an operator context uses
 * ContractCreateFlow: the bytecode goes to a file (FileCreate + FileAppend),
 * then ContractCreate runs the constructor. A wallet context sends small
 * contracts, such as TokenLock, as one ContractCreate with the bytecode
 * inline, so the deploy is one approval; larger ones go through the flow, one
 * approval per transaction.
 */
export async function deployContract(
  hedera: HederaContext,
  params: DeployContractParams,
  signal?: AbortSignal,
): Promise<DeployContractResult> {
  const { artifact } = params;
  const constructor = artifact.abi.find(item => item.type === "constructor");
  const inputs = constructor?.inputs ?? [];
  const values = await toAbiValues(hedera, inputs, params.args ?? [], signal);
  const encoded = inputs.length ? encodeAbiParameters(inputs, values) : "0x";

  const context = `Deploying ${artifact.contractName}`;
  const bytecode = hexToBytes(artifact.bytecode);
  const configure = <T extends ContractCreateFlow | ContractCreateTransaction>(create: T): T => {
    create.setGas(params.gas ?? DEFAULT_DEPLOY_GAS);
    if (params.autoAssociations) create.setMaxAutomaticTokenAssociations(params.autoAssociations);
    if (params.adminKey) create.setAdminKey(hedera.operatorPublicKey);
    if (params.initialHbar !== undefined) {
      create.setInitialBalance(Hbar.fromTinybars(toLong(toUnits(params.initialHbar, 8))));
    }
    if (params.memo) create.setContractMemo(params.memo);
    return create;
  };
  const deployed = (contractId: string | undefined, transactionId: string, gasUsed: number) => {
    if (!contractId) throw new LaunchBlocksError("CONTRACT_NO_ID", "The deployment returned no contract id");
    return {
      contract: artifact.contractName,
      contractId,
      accountId: contractId,
      evmAddress: entityIdToEvmAddress(contractId),
      transactionId,
      gasUsed,
    };
  };

  // Inline initcode runs exactly as given: the node appends constructorParameters
  // only to bytecode it reads from a file. So the arguments go on the end, as in
  // an Ethereum deploy, or the constructor finds none and reverts.
  const initcode = concat([bytecode, hexToBytes(encoded)]);
  const ethereumEligible = !params.adminKey && !params.memo && initcode.length <= ETHEREUM_DEPLOY_LIMIT;
  const from = ethereumEligible ? await ethereumSender(hedera, signal) : null;
  if (from) {
    const result = await deployAsEthereumTransaction(
      hedera,
      from,
      {
        initcode,
        maxGas: params.gas ?? DEFAULT_DEPLOY_GAS,
        valueTinybar: params.initialHbar === undefined ? 0n : toUnits(params.initialHbar, 8),
        context,
      },
      signal,
    );
    await checkTokenSlots(hedera, result.contractId, params.autoAssociations ?? 0, signal);
    return { contract: artifact.contractName, accountId: result.contractId, ...result };
  }
  if (hedera.signer && initcode.length <= INLINE_BYTECODE_LIMIT) {
    const create = configure(new ContractCreateTransaction().setBytecode(initcode));
    const outcome = await sendContract(hedera, create, context, signal);
    return deployed(outcome.receipt.contractId?.toString(), outcome.transactionId, outcome.gasUsed);
  }
  // The flow uploads the bytecode to a file, which must hold it as hex text.
  const flow = configure(
    new ContractCreateFlow().setBytecode(artifact.bytecode.replace(/^0x/, "")),
  ).setConstructorParameters(hexToBytes(encoded));
  // ContractCreateFlow sends several transactions (file create, appends, contract create), so it cannot go
  // through send(); it translates wallet refusals the same way.
  if (hedera.signer) {
    const signer = hedera.signer;
    try {
      const response = await flow.executeWithSigner(signer).catch((error: unknown) => {
        throw translateWalletError(error, context);
      });
      const receipt = await response.getReceipt(hedera.client);
      const transactionId = response.transactionId.toString();
      const { gasUsed } = await fetchContractResult(hedera, transactionId, signal ? { signal } : {});
      return deployed(receipt.contractId?.toString(), transactionId, gasUsed);
    } catch (error) {
      if (error instanceof LaunchBlocksError) throw error;
      throw translateHederaError(error, context);
    }
  }

  // An operator runs the whole flow and reads the record for the gas used.
  try {
    const response = await flow.execute(hedera.client);
    const record = await response.getRecord(hedera.client);
    return deployed(
      record.receipt.contractId?.toString(),
      response.transactionId.toString(),
      Number(record.contractFunctionResult?.gasUsed ?? 0),
    );
  } catch (error) {
    if (error instanceof LaunchBlocksError) throw error;
    throw translateHederaError(error, context);
  }
}

// ── Call ────────────────────────────────────────────────────────────────────

export type CallContractParams = {
  contractId: string;
  /** Solidity signature, e.g. `function release() returns (uint256)`. */
  function: string;
  args?: readonly unknown[] | undefined;
  /** Gas for a transaction; reads ignore it. */
  gas?: number | undefined;
  /** HBAR sent with the call (the function must be payable). */
  payableHbar?: DecimalAmount | undefined;
};

export type CallContractResult = {
  contractId: string;
  function: string;
  /** `read` for view/pure functions (free, through the mirror node), else `write`. */
  mode: "read" | "write";
  /** One return value as a string, several as a JSON array; empty when the function returns nothing. */
  result: string;
  values: unknown[];
  transactionId: string | null;
  gasUsed: number | null;
};

/**
 * Call a function on a deployed contract. View and pure functions are read
 * through the mirror node at no cost, after it has caught up with earlier
 * writes; anything else is a ContractExecuteTransaction.
 */
export async function callContract(
  hedera: HederaContext,
  params: CallContractParams,
  signal?: AbortSignal,
): Promise<CallContractResult> {
  const fn = parseFunctionSignature(params.function);
  const abi = [fn] as const;
  const values = await toAbiValues(hedera, fn.inputs, params.args ?? [], signal);
  const data = encodeFunctionData({ abi, functionName: fn.name, args: values } as never);
  const decode = (raw: `0x${string}`): unknown[] => {
    if (fn.outputs.length === 0 || raw === "0x") return [];
    const decoded = decodeFunctionResult({ abi, functionName: fn.name, data: raw } as never) as unknown;
    return (fn.outputs.length === 1 ? [decoded] : (decoded as unknown[])).map(jsonSafe);
  };

  if (isReadOnly(fn)) {
    if (params.payableHbar !== undefined) {
      throw new LaunchBlocksError("CONTRACT_READ_PAYABLE", `${fn.name} is ${fn.stateMutability}; it cannot take HBAR`);
    }
    await waitForMirror(hedera, Date.now(), signal ? { signal } : {});
    const raw = await readContract(hedera, { to: await toEvmAddress(hedera, params.contractId, signal), data }, signal);
    const decoded = decode(raw as `0x${string}`);
    return {
      contractId: params.contractId,
      function: fn.name,
      mode: "read",
      result: renderResult(decoded),
      values: decoded,
      transactionId: null,
      gasUsed: null,
    };
  }

  const transaction = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(params.contractId))
    .setGas(params.gas ?? DEFAULT_CALL_GAS)
    .setFunctionParameters(hexToBytes(data));
  if (params.payableHbar !== undefined) {
    transaction.setPayableAmount(Hbar.fromTinybars(toLong(toUnits(params.payableHbar, 8))));
  }
  try {
    const outcome = await sendContract(hedera, transaction, `Calling ${fn.name} on ${params.contractId}`, signal);
    const decoded = decode(outcome.output);
    return {
      contractId: params.contractId,
      function: fn.name,
      mode: "write",
      result: renderResult(decoded),
      values: decoded,
      transactionId: outcome.transactionId,
      gasUsed: outcome.gasUsed,
    };
  } catch (error) {
    const translated =
      error instanceof LaunchBlocksError
        ? error
        : translateHederaError(error, `Calling ${fn.name} on ${params.contractId}`);
    throw new LaunchBlocksError(translated.code, translated.message, {
      cause: error,
      hint:
        translated.hint ??
        "If the contract reverted, check the function's conditions (for a TokenLock, the release time) and the gas.",
    });
  }
}
