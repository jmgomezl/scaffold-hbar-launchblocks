import { NextResponse } from "next/server";
import { loadHardhatArtifact } from "@sh/launchblocks";
import { errorResponse } from "~~/services/launchblocks/server";

export const runtime = "nodejs";

/**
 * A compiled contract from the Hardhat package, for flows that run in the
 * browser with a wallet: their Deploy contract block cannot read the disk.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await params;
    const { contractName, sourceName, abi, bytecode } = loadHardhatArtifact(decodeURIComponent(name));
    return NextResponse.json({ contractName, sourceName, abi, bytecode });
  } catch (error) {
    return errorResponse(error);
  }
}
