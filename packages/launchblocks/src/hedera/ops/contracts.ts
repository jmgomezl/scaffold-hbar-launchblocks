import { ContractCreateFlow, ContractExecuteTransaction, ContractId, Hbar } from "@hiero-ledger/sdk";
import type { AbiFunction, AbiParameter } from "viem";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, hexToBytes, parseAbiItem, toHex } from "viem";

import type { ContractArtifact } from "../../contracts/artifacts";
import { LaunchBlocksError } from "../../errors";
import { entityIdToEvmAddress } from "../abi";
import type { DecimalAmount } from "../amounts";
import { toLong, toUnits } from "../amounts";
import type { HederaContext } from "../context";
import { translateHederaError } from "../errors";
import { fetchAccount, readContract, waitForMirror } from "../mirror";

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

/**
 * Deploy a compiled contract with ContractCreateFlow: the bytecode goes to a
 * file (FileCreate + FileAppend), then ContractCreate runs the constructor.
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

  const flow = new ContractCreateFlow()
    .setBytecode(artifact.bytecode.replace(/^0x/, ""))
    .setGas(params.gas ?? DEFAULT_DEPLOY_GAS)
    .setConstructorParameters(hexToBytes(encoded));
  if (params.autoAssociations) flow.setMaxAutomaticTokenAssociations(params.autoAssociations);
  if (params.adminKey) flow.setAdminKey(hedera.operatorKey.publicKey);
  if (params.initialHbar !== undefined)
    flow.setInitialBalance(Hbar.fromTinybars(toLong(toUnits(params.initialHbar, 8))));
  if (params.memo) flow.setContractMemo(params.memo);

  try {
    const response = await flow.execute(hedera.client);
    const record = await response.getRecord(hedera.client);
    const contractId = record.receipt.contractId?.toString();
    if (!contractId) throw new LaunchBlocksError("CONTRACT_NO_ID", "The deployment returned no contract id");
    return {
      contract: artifact.contractName,
      contractId,
      accountId: contractId,
      evmAddress: entityIdToEvmAddress(contractId),
      transactionId: response.transactionId.toString(),
      gasUsed: Number(record.contractFunctionResult?.gasUsed ?? 0),
    };
  } catch (error) {
    if (error instanceof LaunchBlocksError) throw error;
    throw translateHederaError(error, `Deploying ${artifact.contractName}`);
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
    const response = await transaction.execute(hedera.client);
    const record = await response.getRecord(hedera.client);
    const bytes = record.contractFunctionResult?.bytes;
    const decoded = bytes && bytes.length ? decode(toHex(bytes)) : [];
    return {
      contractId: params.contractId,
      function: fn.name,
      mode: "write",
      result: renderResult(decoded),
      values: decoded,
      transactionId: response.transactionId.toString(),
      gasUsed: Number(record.contractFunctionResult?.gasUsed ?? 0),
    };
  } catch (error) {
    const translated = translateHederaError(error, `Calling ${fn.name} on ${params.contractId}`);
    throw new LaunchBlocksError(translated.code, translated.message, {
      cause: error,
      hint:
        translated.hint ??
        "If the contract reverted, check the function's conditions (for a TokenLock, the release time) and the gas.",
    });
  }
}
