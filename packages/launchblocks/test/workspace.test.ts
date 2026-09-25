import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const manifest = (file: string) => JSON.parse(readFileSync(path.resolve(__dirname, file), "utf8"));

describe("the workspace", () => {
  it("links the app to this package: its dependency range names this version", () => {
    // npm workspaces link a local package only when the range matches its version; otherwise an
    // install looks for @sh/launchblocks on the registry, where it does not exist.
    const { version } = manifest("../package.json");
    const range = manifest("../../nextjs/package.json").dependencies["@sh/launchblocks"];
    expect(range).toBe(`^${version}`);
  });
});
