import { NextResponse } from "next/server";
import { generateHarnessRecipe } from "@sh/launchblocks";
import { errorResponse, getRegistry, projectPackageManager, readJsonBody } from "~~/services/launchblocks/server";

export const runtime = "nodejs";

/** Export a flow as a Hedera Harness recipe: the files, the cost estimate and the commands to run it. */
export async function POST(req: Request) {
  try {
    const document = await readJsonBody(req);
    // A built-in example is exported as a copy, so a click on Export never dead-ends.
    const recipe = generateHarnessRecipe(document, getRegistry(), {
      packageManager: projectPackageManager(),
      galleryConflict: "copy",
    });
    return NextResponse.json(recipe);
  } catch (error) {
    return errorResponse(error);
  }
}
