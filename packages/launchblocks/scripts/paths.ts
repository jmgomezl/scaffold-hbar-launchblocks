import { existsSync } from "node:fs";
import path from "node:path";

/** The project root; these scripts live in packages/launchblocks/scripts. */
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Find a file named on the command line. Workspace scripts run inside the
 * package: npm passes the directory the command was typed in as INIT_CWD,
 * other managers set it to the package, so the project root is tried next.
 */
export function findCallerFile(file: string): { found?: string; tried: string[] } {
  const tried = [
    ...new Set([path.resolve(process.env.INIT_CWD ?? process.cwd(), file), path.resolve(PROJECT_ROOT, file)]),
  ];
  const found = tried.find(candidate => existsSync(candidate));
  return found ? { found, tried } : { tried };
}
