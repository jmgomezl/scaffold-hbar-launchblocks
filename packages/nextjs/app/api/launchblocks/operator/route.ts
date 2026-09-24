import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * The account that signs runs when no wallet is connected, for the studio to
 * name it. Only the public account id and network: never the key.
 */
export async function GET() {
  const accountId = process.env.HEDERA_OPERATOR_ID?.trim() || null;
  const network = process.env.HEDERA_NETWORK?.trim() || "testnet";
  return NextResponse.json({ accountId, network });
}
