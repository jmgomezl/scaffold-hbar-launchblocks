import { NextResponse } from "next/server";
import { stepCatalog } from "@sh/launchblocks";
import { getRegistry } from "~~/services/launchblocks/server";

export const runtime = "nodejs";

/** The step catalog the editor renders: UI spec, docs, input JSON schema and example output. */
export async function GET() {
  return NextResponse.json({ steps: stepCatalog(getRegistry()) });
}
