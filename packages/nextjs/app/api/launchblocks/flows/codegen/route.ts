import { NextResponse } from "next/server";
import { generateLaunchScript } from "@sh/launchblocks";
import { errorResponse, getRegistry, readJsonBody } from "~~/services/launchblocks/server";

export const runtime = "nodejs";

/** Render a flow as a launch.ts script. */
export async function POST(req: Request) {
  try {
    const document = await readJsonBody(req);
    const source = generateLaunchScript(document, getRegistry(), {
      headerLines: ["Exported from the LaunchBlocks editor."],
    });
    return NextResponse.json({ source });
  } catch (error) {
    return errorResponse(error);
  }
}
