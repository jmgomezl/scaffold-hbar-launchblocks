import { LaunchBlocksError } from "../errors";

/**
 * Minimal ABI encoding for the handful of read-only calls this template
 * makes. Full ABI coding would mean pulling ethers into the core package;
 * these helpers cover static types only and are unit-tested.
 */

const HEX = /^[0-9a-fA-F]*$/;

/** Left-pad a hex value to a 32-byte word. */
export function word(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  if (!HEX.test(clean) || clean.length > 64) {
    throw new LaunchBlocksError("ABI_INVALID", `"${hex}" is not encodable as a 32-byte word`);
  }
  return clean.toLowerCase().padStart(64, "0");
}

export function encodeAddress(address: string): string {
  const clean = address.replace(/^0x/, "");
  if (clean.length !== 40 || !HEX.test(clean)) {
    throw new LaunchBlocksError("ABI_INVALID", `"${address}" is not a 20-byte EVM address`);
  }
  return word(clean);
}

export function encodeUint(value: bigint | number): string {
  const big = BigInt(value);
  if (big < 0n) throw new LaunchBlocksError("ABI_INVALID", "uint cannot be negative");
  return word(big.toString(16));
}

/** `selector` is the 4-byte function selector including the 0x prefix. */
export function encodeCall(selector: string, ...args: string[]): string {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) {
    throw new LaunchBlocksError("ABI_INVALID", `"${selector}" is not a 4-byte selector`);
  }
  return selector + args.join("");
}

/** Decode a single 32-byte word at `index` as a uint256. */
export function decodeUint(data: string, index = 0): bigint {
  const clean = data.replace(/^0x/, "");
  const slice = clean.slice(index * 64, (index + 1) * 64);
  if (slice.length !== 64) {
    throw new LaunchBlocksError("ABI_DECODE", `Response has no word at index ${index}`);
  }
  return BigInt(`0x${slice}`);
}

/** Decode a 32-byte word as a 20-byte EVM address. */
export function decodeAddress(data: string, index = 0): string {
  const clean = data.replace(/^0x/, "");
  const slice = clean.slice(index * 64, (index + 1) * 64);
  if (slice.length !== 64) {
    throw new LaunchBlocksError("ABI_DECODE", `Response has no word at index ${index}`);
  }
  return `0x${slice.slice(24)}`;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Hedera entity id (`0.0.x`) to the EVM address the EVM sees for it. */
export function entityIdToEvmAddress(entityId: string): string {
  const parts = entityId.trim().split(".");
  if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) {
    throw new LaunchBlocksError("ENTITY_ID_INVALID", `"${entityId}" is not a shard.realm.num entity id`);
  }
  return `0x${BigInt(parts[2] as string)
    .toString(16)
    .padStart(40, "0")}`;
}

/** The inverse, for long-zero addresses only (0.0.x form). */
export function evmAddressToEntityId(address: string): string {
  const clean = address.replace(/^0x/, "");
  if (clean.length !== 40 || !HEX.test(clean)) {
    throw new LaunchBlocksError("ABI_INVALID", `"${address}" is not a 20-byte EVM address`);
  }
  if (!/^0{24}/.test(clean)) {
    throw new LaunchBlocksError(
      "ADDRESS_NOT_LONG_ZERO",
      `${address} is an aliased EVM address, not a long-zero address; resolve it through the mirror node`,
    );
  }
  return `0.0.${BigInt(`0x${clean}`).toString(10)}`;
}
