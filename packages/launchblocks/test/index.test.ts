import { describe, expect, it } from "vitest";

import { LAUNCHBLOCKS_VERSION } from "../src";

describe("package entrypoint", () => {
  it("exposes a semver version", () => {
    expect(LAUNCHBLOCKS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
