import { describe, expect, it } from "vitest";
import { toApiError } from "~~/app/launch/_lib/api";

describe("toApiError", () => {
  it("keeps the code, message and hint of a server or core error", () => {
    const error = Object.assign(new Error("declined in the wallet"), { code: "WALLET_REJECTED", hint: "Approve it" });
    expect(toApiError(error)).toEqual({
      code: "WALLET_REJECTED",
      message: "declined in the wallet",
      hint: "Approve it",
    });
  });

  it("gives anything else the fallback code", () => {
    expect(toApiError(new TypeError("Failed to fetch"), "RUN_FAILED")).toEqual({
      code: "RUN_FAILED",
      message: "Failed to fetch",
    });
  });

  it("tells a page that outlived a deploy to reload, instead of showing a chunk URL", () => {
    const stale = Object.assign(
      new Error("Loading chunk 9763 failed.\n(error: https://example.org/_next/static/chunks/9763.js)"),
      {
        name: "ChunkLoadError",
      },
    );
    expect(toApiError(stale, "WALLET_RUN_FAILED")).toMatchObject({
      code: "APP_UPDATED",
      hint: "Reload the page, then run again. Nothing was sent.",
    });
    expect(toApiError(new Error("Loading CSS chunk 12 failed."))).toMatchObject({ code: "APP_UPDATED" });
  });
});
