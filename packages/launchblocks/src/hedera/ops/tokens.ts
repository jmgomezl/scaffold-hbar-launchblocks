import type { Key } from "@hiero-ledger/sdk";
import {
  AccountId,
  CustomFixedFee,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
  TokenAirdropTransaction,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenId,
  TokenInfoQuery,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  TransferTransaction,
} from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../../errors";
import type { DecimalAmount } from "../amounts";
import { fromUnits, toLong, toUnits } from "../amounts";
import type { HederaContext } from "../context";
import { translateHederaError } from "../errors";
import { fetchToken, fetchTokenTransfers } from "../mirror";
import { send, submit } from "./submit";

/**
 * Hedera Token Service operations behind the `hts.*` blocks.
 *
 * Every operation has a pure `build*` function (unit-testable, no network)
 * and an async function that submits it as the context's account: the
 * operator on the server, or a connected wallet. That account is always the
 * treasury and the holder of every enabled key: this template signs with one
 * key on purpose, so a flow never needs a second signer.
 */

export type TokenKeys = {
  admin: boolean;
  supply: boolean;
  freeze: boolean;
  wipe: boolean;
  pause: boolean;
  kyc: boolean;
  feeSchedule: boolean;
};

export type FractionalFee = {
  /** Fee = amount × numerator / denominator, e.g. 1/100 for 1%. */
  numerator: number;
  denominator: number;
  /** Bounds in whole tokens (optional). */
  min?: DecimalAmount | undefined;
  max?: DecimalAmount | undefined;
  /** Defaults to the operator (treasury). */
  collectorAccountId?: string | undefined;
  /** `inclusive`: taken out of the amount sent; `exclusive`: charged on top to the sender. */
  assessment: "inclusive" | "exclusive";
};

export type FixedHbarFee = {
  /** Charged to the sender on every transfer, in HBAR. */
  amountHbar: DecimalAmount;
  collectorAccountId?: string | undefined;
};

export type CreateFungibleTokenParams = {
  name: string;
  symbol: string;
  decimals: number;
  /** Whole tokens minted to the treasury at creation. */
  initialSupply: DecimalAmount;
  supplyType: "infinite" | "finite";
  /** Whole tokens; required when `supplyType` is `finite`. */
  maxSupply?: DecimalAmount | undefined;
  memo?: string | undefined;
  keys: TokenKeys;
  fractionalFee?: FractionalFee | undefined;
  fixedHbarFee?: FixedHbarFee | undefined;
};

export type CreateFungibleTokenResult = {
  tokenId: string;
  transactionId: string;
  treasuryAccountId: string;
  symbol: string;
  decimals: number;
  /** Human amount, e.g. "1000000". */
  initialSupply: string;
  /** Smallest units as a decimal string (may exceed Number range). */
  initialSupplyUnits: string;
  supplyType: "infinite" | "finite";
  maxSupplyUnits: string | null;
};

export function buildTokenCreate(hedera: HederaContext, params: CreateFungibleTokenParams): TokenCreateTransaction {
  const { operatorPublicKey } = hedera;
  const initialSupplyUnits = toUnits(params.initialSupply, params.decimals);

  const tx = new TokenCreateTransaction()
    .setTokenName(params.name)
    .setTokenSymbol(params.symbol)
    .setDecimals(params.decimals)
    .setInitialSupply(toLong(initialSupplyUnits))
    .setTreasuryAccountId(hedera.operatorId)
    .setTokenType(TokenType.FungibleCommon)
    .setFreezeDefault(false);

  if (params.supplyType === "finite") {
    if (params.maxSupply === undefined) {
      throw new LaunchBlocksError("MAX_SUPPLY_REQUIRED", "A finite token needs maxSupply");
    }
    const maxSupplyUnits = toUnits(params.maxSupply, params.decimals);
    if (maxSupplyUnits < initialSupplyUnits) {
      throw new LaunchBlocksError("MAX_SUPPLY_TOO_LOW", "maxSupply must be at least initialSupply");
    }
    tx.setSupplyType(TokenSupplyType.Finite).setMaxSupply(toLong(maxSupplyUnits));
  } else {
    tx.setSupplyType(TokenSupplyType.Infinite);
  }

  if (params.memo) tx.setTokenMemo(params.memo);

  const setKey = (enabled: boolean, apply: (key: Key) => unknown): void => {
    if (enabled) apply(operatorPublicKey);
  };
  setKey(params.keys.admin, key => tx.setAdminKey(key));
  setKey(params.keys.supply, key => tx.setSupplyKey(key));
  setKey(params.keys.freeze, key => tx.setFreezeKey(key));
  setKey(params.keys.wipe, key => tx.setWipeKey(key));
  setKey(params.keys.pause, key => tx.setPauseKey(key));
  setKey(params.keys.kyc, key => tx.setKycKey(key));
  setKey(params.keys.feeSchedule, key => tx.setFeeScheduleKey(key));

  const customFees: (CustomFractionalFee | CustomFixedFee)[] = [];
  if (params.fractionalFee) customFees.push(buildFractionalFee(hedera, params.fractionalFee, params.decimals));
  if (params.fixedHbarFee) customFees.push(buildFixedHbarFee(hedera, params.fixedHbarFee));
  if (customFees.length) tx.setCustomFees(customFees);

  return tx;
}

function buildFractionalFee(hedera: HederaContext, fee: FractionalFee, decimals: number): CustomFractionalFee {
  if (fee.denominator <= 0 || fee.numerator <= 0) {
    throw new LaunchBlocksError("FEE_INVALID", "Fractional fee numerator and denominator must be positive");
  }
  const custom = new CustomFractionalFee()
    .setNumerator(fee.numerator)
    .setDenominator(fee.denominator)
    .setFeeCollectorAccountId(fee.collectorAccountId ? AccountId.fromString(fee.collectorAccountId) : hedera.operatorId)
    .setAssessmentMethod(
      fee.assessment === "exclusive" ? FeeAssessmentMethod.Exclusive : FeeAssessmentMethod.Inclusive,
    );
  if (fee.min !== undefined) custom.setMin(toLong(toUnits(fee.min, decimals)));
  if (fee.max !== undefined) custom.setMax(toLong(toUnits(fee.max, decimals)));
  return custom;
}

function buildFixedHbarFee(hedera: HederaContext, fee: FixedHbarFee): CustomFixedFee {
  return new CustomFixedFee()
    .setHbarAmount(new Hbar(typeof fee.amountHbar === "number" ? fee.amountHbar : Number(fee.amountHbar)))
    .setFeeCollectorAccountId(
      fee.collectorAccountId ? AccountId.fromString(fee.collectorAccountId) : hedera.operatorId,
    );
}

export async function createFungibleToken(
  hedera: HederaContext,
  params: CreateFungibleTokenParams,
): Promise<CreateFungibleTokenResult> {
  const tx = buildTokenCreate(hedera, params);
  const initialSupplyUnits = tx.initialSupply?.toString() ?? "0";
  const maxSupplyUnits = params.supplyType === "finite" ? (tx.maxSupply?.toString() ?? null) : null;

  return submit(hedera, tx, `Creating token ${params.symbol}`, (receipt, transactionId) => {
    if (!receipt.tokenId) {
      throw new LaunchBlocksError("RECEIPT_INCOMPLETE", "Token creation succeeded but the receipt has no token id");
    }
    return {
      tokenId: receipt.tokenId.toString(),
      transactionId,
      treasuryAccountId: hedera.operatorId.toString(),
      symbol: params.symbol,
      decimals: params.decimals,
      initialSupply: fromUnits(initialSupplyUnits, params.decimals),
      initialSupplyUnits,
      supplyType: params.supplyType,
      maxSupplyUnits,
    };
  });
}

export type TokenInfoSummary = {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyUnits: string;
  treasuryAccountId: string | null;
};

/**
 * Token metadata. An operator context asks a consensus node (immediate, unlike
 * the mirror node). A wallet context asks the mirror node, retrying until it
 * has caught up: a TokenInfoQuery is a paid query the wallet would have to approve.
 */
export async function getTokenInfo(hedera: HederaContext, tokenId: string): Promise<TokenInfoSummary> {
  if (hedera.signer) return fetchToken(hedera, tokenId);
  try {
    const info = await new TokenInfoQuery().setTokenId(TokenId.fromString(tokenId)).execute(hedera.client);
    return {
      tokenId: info.tokenId.toString(),
      name: info.name,
      symbol: info.symbol,
      decimals: Number(info.decimals),
      totalSupplyUnits: info.totalSupply.toString(),
      treasuryAccountId: info.treasuryAccountId?.toString() ?? null,
    };
  } catch (error) {
    throw translateHederaError(error, `Reading token ${tokenId}`);
  }
}

export type MintParams = { tokenId: string; amount: DecimalAmount };
export type MintResult = {
  tokenId: string;
  transactionId: string;
  mintedUnits: string;
  newTotalSupplyUnits: string;
  newTotalSupply: string;
};

export function buildTokenMint(params: MintParams, decimals: number): TokenMintTransaction {
  return new TokenMintTransaction()
    .setTokenId(TokenId.fromString(params.tokenId))
    .setAmount(toLong(toUnits(params.amount, decimals)));
}

/** Mint more supply into the treasury. Needs the token's supply key (the operator's). */
export async function mintFungibleToken(hedera: HederaContext, params: MintParams): Promise<MintResult> {
  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const tx = buildTokenMint(params, decimals);
  return submit(hedera, tx, `Minting ${params.amount} of ${params.tokenId}`, (receipt, transactionId) => {
    if (!receipt.totalSupply) {
      throw new LaunchBlocksError("RECEIPT_INCOMPLETE", "Mint succeeded but the receipt has no total supply");
    }
    const total = receipt.totalSupply.toString();
    return {
      tokenId: params.tokenId,
      transactionId,
      mintedUnits: tx.amount?.toString() ?? "0",
      newTotalSupplyUnits: total,
      newTotalSupply: fromUnits(total, decimals),
    };
  });
}

export type TransferParams = { tokenId: string; to: string; amount: DecimalAmount; memo?: string | undefined };
export type TransferResult = { tokenId: string; to: string; amountUnits: string; transactionId: string };

export function buildTokenTransfer(
  hedera: HederaContext,
  params: TransferParams,
  decimals: number,
): TransferTransaction {
  const units = toLong(toUnits(params.amount, decimals));
  const tokenId = TokenId.fromString(params.tokenId);
  const tx = new TransferTransaction()
    .addTokenTransfer(tokenId, hedera.operatorId, units.negate())
    .addTokenTransfer(tokenId, AccountId.fromString(params.to), units);
  if (params.memo) tx.setTransactionMemo(params.memo);
  return tx;
}

/** Move tokens from the treasury (operator) to an account that already holds the token. */
export async function transferFungibleToken(hedera: HederaContext, params: TransferParams): Promise<TransferResult> {
  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const tx = buildTokenTransfer(hedera, params, decimals);
  return submit(
    hedera,
    tx,
    `Transferring ${params.amount} of ${params.tokenId} to ${params.to}`,
    (_, transactionId) => ({
      tokenId: params.tokenId,
      to: params.to,
      amountUnits: toUnits(params.amount, decimals).toString(),
      transactionId,
    }),
  );
}

export type AirdropRecipient = { accountId: string; amount: DecimalAmount };
export type AirdropParams = { tokenId: string; recipients: AirdropRecipient[]; memo?: string | undefined };
export type AirdropResult = {
  tokenId: string;
  transactionId: string;
  recipientCount: number;
  totalUnits: string;
  /** Recipients without association or free auto-association slots; they must claim (HIP-904). */
  pendingCount: number;
};

export function buildTokenAirdrop(
  hedera: HederaContext,
  params: AirdropParams,
  decimals: number,
): TokenAirdropTransaction {
  if (params.recipients.length === 0) {
    throw new LaunchBlocksError("AIRDROP_EMPTY", "An airdrop needs at least one recipient");
  }
  if (params.recipients.length > 10) {
    throw new LaunchBlocksError("AIRDROP_TOO_MANY", "HTS airdrops take at most 10 transfers per transaction");
  }
  const tokenId = TokenId.fromString(params.tokenId);
  const tx = new TokenAirdropTransaction();
  let total = 0n;
  for (const recipient of params.recipients) {
    const units = toUnits(recipient.amount, decimals);
    if (units === 0n) {
      throw new LaunchBlocksError("AIRDROP_ZERO", `Airdrop amount for ${recipient.accountId} must be positive`);
    }
    total += units;
    tx.addTokenTransfer(tokenId, AccountId.fromString(recipient.accountId), toLong(units));
  }
  tx.addTokenTransfer(tokenId, hedera.operatorId, toLong(total).negate());
  if (params.memo) tx.setTransactionMemo(params.memo);
  return tx;
}

/**
 * Send tokens to accounts that may not have associated the token (HIP-904).
 * Recipients with a free auto-association slot receive immediately; others
 * get a pending airdrop they can claim.
 */
export async function airdropFungibleToken(hedera: HederaContext, params: AirdropParams): Promise<AirdropResult> {
  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const tx = buildTokenAirdrop(hedera, params, decimals);
  const totalUnits = params.recipients.reduce((sum, r) => sum + toUnits(r.amount, decimals), 0n).toString();
  const context = `Airdropping ${params.tokenId}`;
  const result = (transactionId: string, pendingCount: number): AirdropResult => ({
    tokenId: params.tokenId,
    transactionId,
    recipientCount: params.recipients.length,
    totalUnits,
    pendingCount,
  });
  if (hedera.signer) {
    // The record would be a paid query through the wallet; the mirror node shows who received instead.
    const { transactionId } = await send(hedera, tx, context);
    const transfers = await fetchTokenTransfers(hedera, transactionId);
    const sender = hedera.operatorId.toString();
    const received = new Set(
      transfers
        .filter(t => t.tokenId === params.tokenId && t.amount > 0n && t.accountId !== sender)
        .map(t => t.accountId),
    );
    return result(transactionId, Math.max(0, params.recipients.length - received.size));
  }
  try {
    const response = await tx.execute(hedera.client);
    // getRecord throws on a failed receipt status, so success is implied here.
    const record = await response.getRecord(hedera.client);
    return result(response.transactionId.toString(), record.newPendingAirdrops.length);
  } catch (error) {
    throw translateHederaError(error, context);
  }
}

export type AssociateResult = {
  tokenId: string;
  accountId: string;
  transactionId: string | null;
  alreadyAssociated: boolean;
};

export function buildTokenAssociate(hedera: HederaContext, tokenId: string): TokenAssociateTransaction {
  return new TokenAssociateTransaction().setAccountId(hedera.operatorId).setTokenIds([TokenId.fromString(tokenId)]);
}

/** Associate the operator with a token so it can receive it. Idempotent. */
export async function associateOperator(hedera: HederaContext, tokenId: string): Promise<AssociateResult> {
  const accountId = hedera.operatorId.toString();
  try {
    return await submit(hedera, buildTokenAssociate(hedera, tokenId), `Associating ${tokenId}`, (_, transactionId) => ({
      tokenId,
      accountId,
      transactionId,
      alreadyAssociated: false,
    }));
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
      return { tokenId, accountId, transactionId: null, alreadyAssociated: true };
    }
    throw error;
  }
}
