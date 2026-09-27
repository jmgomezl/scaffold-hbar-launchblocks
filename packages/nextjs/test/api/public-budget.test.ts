import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reservePublicRun } from "~~/services/launchblocks/public-budget";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "launchblocks-ledger-"));
  file = path.join(dir, "usage.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const reserve = (file: string, visitor: string) =>
  reservePublicRun({ file, visitor, hbar: 10, budget: 10, runsPerHour: 20 });

describe("persistent public budget", () => {
  it("retains charged reservations but refunds a run that sent nothing, idempotently", () => {
    const first = reserve(file, "a");
    if ("refused" in first) throw new Error("expected first reservation");
    expect(reserve(file, "b")).toMatchObject({ refused: { code: "PUBLIC_BUDGET_SPENT" } });
    first.release(true);
    const next = reserve(file, "a");
    if ("refused" in next) throw new Error("expected refunded reservation");
    first.release(true);
    expect(reserve(file, "a")).toMatchObject({ refused: { code: "RUN_IN_PROGRESS" } });
    next.release(false);
    expect(reserve(file, "b")).toMatchObject({ refused: { code: "PUBLIC_BUDGET_SPENT" } });
  });

  it("fails closed on corruption and a held lock, without changing the ledger", () => {
    reserve(file, "a");
    const original = readFileSync(file, "utf8");
    writeFileSync(`${file}.lock`, "");
    expect(() => reserve(file, "b")).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
    rmSync(`${file}.lock`);
    writeFileSync(file, '{"version":1,"entries":[{"hbar":-1000}]}');
    expect(() => reserve(file, "b")).toThrow(/Invalid public budget/);
    writeFileSync(file, "{");
    expect(() => reserve(file, "b")).toThrow();
  });

  it("expires a crashed worker's visitor lease without refunding its spending", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    reserve(file, "a");
    vi.mocked(Date.now).mockReturnValue(now + 240_001);
    expect(reserve(file, "a")).toMatchObject({ refused: { code: "PUBLIC_BUDGET_SPENT" } });
    vi.mocked(Date.now).mockReturnValue(now + 3_600_001);
    expect(reserve(file, "a")).toHaveProperty("release");
  });

  it("does not over-reserve when separate processes race for the final allowance", async () => {
    const requireCore = createRequire(path.resolve("../launchblocks/package.json"));
    const cli = requireCore.resolve("tsx/cli");
    const worker = path.resolve("test/fixtures/reserve-budget.mjs");
    const run = (visitor: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, worker, file, visitor], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let error = "";
        child.stdout.on("data", data => {
          output += data.toString();
        });
        child.stderr.on("data", data => {
          error += data.toString();
        });
        child.on("error", reject);
        child.on("exit", code => (code === 0 ? resolve(output) : reject(new Error(error))));
      });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => run(String(i))));
    expect(results.filter(result => result === "reserved")).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    expect(ledger.entries.reduce((sum: number, entry: { hbar: number }) => sum + entry.hbar, 0)).toBe(10);
  }, 15_000);
});
