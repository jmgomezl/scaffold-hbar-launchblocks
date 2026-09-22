import { NextResponse } from "next/server";
import { GALLERY } from "@sh/launchblocks";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ flows: GALLERY });
}
