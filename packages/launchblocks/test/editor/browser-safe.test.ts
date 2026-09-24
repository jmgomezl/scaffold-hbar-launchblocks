import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The editor entry point ships to the browser. Walk its runtime (non-type)
 * imports and fail if any reachable module pulls in zod or the Hedera SDK.
 */
const SRC = path.resolve(__dirname, "../../src");
const FORBIDDEN = ["zod", "@hiero-ledger/sdk"];

function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1] as string);
  return specifiers;
}

function reachable(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith(".")) {
        const base = path.resolve(path.dirname(file), specifier);
        const candidates = [`${base}.ts`, path.join(base, "index.ts")];
        const resolved = candidates.find(candidate => {
          try {
            readFileSync(candidate);
            return true;
          } catch {
            return false;
          }
        });
        if (resolved) visit(resolved);
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(entry);
  return { modules, packages };
}

const NODE_ONLY = ["fs", "path", "os", "child_process", "dotenv"];

describe("@sh/launchblocks/browser", () => {
  it("reaches no Node built-ins or env loading at runtime, so a page can run flows", () => {
    const { modules, packages } = reachable(path.join(SRC, "browser.ts"));
    expect(modules.size).toBeGreaterThan(20);
    expect([...packages].filter(name => name.startsWith("node:") || NODE_ONLY.includes(name))).toEqual([]);
    expect([...modules].some(file => file.endsWith(path.join("contracts", "artifacts.ts")))).toBe(false);
  });

  it("would catch a Node import (the walker works)", () => {
    const { packages } = reachable(path.join(SRC, "contracts/artifacts.ts"));
    expect(packages.has("node:fs")).toBe(true);
  });
});

describe("@sh/launchblocks/editor", () => {
  it("reaches no zod or Hedera SDK code at runtime", () => {
    const { modules, packages } = reachable(path.join(SRC, "editor/index.ts"));
    expect(modules.size).toBeGreaterThan(1);
    expect(
      [...packages].filter(name => FORBIDDEN.some(forbidden => name === forbidden || name.startsWith(`${forbidden}/`))),
    ).toEqual([]);
  });

  it("would catch a forbidden import (the walker works)", () => {
    const { packages } = reachable(path.join(SRC, "flow/schema.ts"));
    expect(packages.has("zod")).toBe(true);
  });
});
