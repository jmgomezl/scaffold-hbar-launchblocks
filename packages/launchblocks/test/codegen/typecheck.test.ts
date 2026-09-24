import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { generateLaunchScript } from "../../src/codegen/typescript";
import { GALLERY } from "../../src/gallery";
import { createDefaultRegistry } from "../../src/steps";

const PACKAGE_ROOT = path.resolve(__dirname, "../..");

/**
 * Type-check generated scripts against this package's source, in memory,
 * with the package's own strictness. Only errors in the generated files
 * count; the source is checked by `check-types`.
 */
function typeErrors(scripts: Record<string, string>): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
    baseUrl: PACKAGE_ROOT,
    paths: { "@sh/launchblocks": ["src/index.ts"] },
  };
  const files = new Map(Object.entries(scripts).map(([name, source]) => [path.join(PACKAGE_ROOT, name), source]));
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = file => files.has(file) || fileExists.call(host, file);
  host.readFile = file => files.get(file) ?? readFile.call(host, file);
  host.getSourceFile = (file, language, ...rest) => {
    const source = files.get(file);
    return source === undefined
      ? getSourceFile.call(host, file, language, ...rest)
      : ts.createSourceFile(file, source, language);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.file && files.has(diagnostic.file.fileName))
    .map(diagnostic => {
      const where = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return `${path.basename(diagnostic.file!.fileName)}:${where.line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    });
}

describe("generated launch scripts", () => {
  it("type-check for every gallery flow", () => {
    const registry = createDefaultRegistry();
    const scripts = Object.fromEntries(
      GALLERY.map(entry => [`__generated__/${entry.id}.ts`, generateLaunchScript(entry.flow, registry)]),
    );
    expect(typeErrors(scripts)).toEqual([]);
  }, 120_000);
});
