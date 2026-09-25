import { existsSync } from "node:fs";
import path from "node:path";

/** The project root; these scripts live in packages/launchblocks/scripts. */
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Find a file named on the command line. Workspace scripts run inside the
 * package. Under npm, INIT_CWD is the directory the command was typed in;
 * other managers set it to the package, so the project root is tried next.
 */
/**
 * Where to write a file named on the command line: under npm, relative to the
 * directory the command was typed in; else (INIT_CWD is the package) to the project root.
 */
export function callerPath(file: string): string {
  const typedIn = process.env.INIT_CWD;
  const base = typedIn && path.resolve(typedIn) !== path.resolve(__dirname, "..") ? typedIn : PROJECT_ROOT;
  return path.resolve(base, file);
}

export function findCallerFile(file: string): { found?: string; tried: string[] } {
  const tried = [
    ...new Set([path.resolve(process.env.INIT_CWD ?? process.cwd(), file), path.resolve(PROJECT_ROOT, file)]),
  ];
  const found = tried.find(candidate => existsSync(candidate));
  return found ? { found, tried } : { tried };
}
