import { NextResponse } from "next/server";
import { errorResponse, getRegistry, readJsonBody } from "~~/services/launchblocks/server";

export const runtime = "nodejs";

/** Validate a flow document. Always 200 with `{ ok, issues }` so editors can show inline problems. */
export async function POST(req: Request) {
  try {
    const document = await readJsonBody(req);
    const result = getRegistry().checkFlow(document);
    return NextResponse.json({ ok: result.flow !== null, issues: result.issues });
  } catch (error) {
    return errorResponse(error);
  }
}
