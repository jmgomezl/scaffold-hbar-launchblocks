import { FlowValidationError, LaunchBlocksError } from "@sh/launchblocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, readJsonBody } from "~~/services/launchblocks/server";
import { json, post, validFlow } from "~~/test/helpers";

afterEach(() => vi.restoreAllMocks());

describe("errorResponse", () => {
  it.each([
    ["AMOUNT_INVALID", 400],
    ["CONTRACT_ARTIFACT_MISSING", 404],
    ["NETWORK_MISMATCH", 409],
    ["CONTRACT_ARTIFACTS_MISSING", 500],
    ["PYTH_URL_INVALID", 500],
    ["MIRROR_UNREACHABLE", 502],
    ["PYTH_NOT_ENTITLED", 502],
    ["OPERATOR_MISSING", 503],
  ])("answers %s with %i, keeping the message and hint", async (code, status) => {
    const error = new LaunchBlocksError(code, "what went wrong", { hint: "what to do" });
    expect(await json(errorResponse(error))).toEqual({
      status,
      body: { error: { code, message: "what went wrong", hint: "what to do" } },
    });
  });

  it("lists an invalid flow's issues", async () => {
    const error = (() => {
      try {
        validFlow({ schemaVersion: 1, id: "x", name: "x", network: "testnet", steps: [{ id: "a", type: "hts.nope" }] });
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(FlowValidationError);
    const { status, body } = await json(errorResponse(error));
    expect(status).toBe(400);
    expect(body.error.code).toBe("FLOW_INVALID");
    expect(body.error.issues).toEqual([expect.objectContaining({ path: "steps[0].type", stepId: "a" })]);
  });

  it("hides anything unexpected behind a generic 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { status, body } = await json(errorResponse(new Error("ECONNRESET at 10.0.0.3:5432 (password=hunter2)")));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Unexpected server error" } });
    expect(logged).toHaveBeenCalled();
  });
});

describe("readJsonBody", () => {
  it("rejects a body that is not JSON", async () => {
    await expect(readJsonBody(post("/api", "{not json"))).rejects.toMatchObject({ code: "BODY_INVALID" });
  });

  it("takes only application/json, which another site cannot send without a preflight", async () => {
    const asText = post("/api", "{}", { "content-type": "text/plain" });
    await expect(readJsonBody(asText)).rejects.toMatchObject({ code: "BODY_NOT_JSON" });
    expect((await json(errorResponse(await readJsonBody(asText).catch(error => error)))).status).toBe(415);
  });

  it("refuses a body over 256 KB", async () => {
    const huge = post("/api", JSON.stringify({ padding: "x".repeat(300 * 1024) }));
    await expect(readJsonBody(huge)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
  });
});
