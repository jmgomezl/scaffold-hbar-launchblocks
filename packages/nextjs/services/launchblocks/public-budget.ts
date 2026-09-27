import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const HOUR_MS = 3_600_000;
// Runs time out after 180 seconds; retain a crash's visitor lease for another minute.
const LEASE_MS = 240_000;
type Entry = { id: string; visitor: string; at: number; hbar: number; activeUntil: number };
type Ledger = { version: 1; entries: Entry[] };
type Refusal = { code: string; message: string; hint: string };
export type Reservation = { refused: Refusal } | { release: (sentNothing: boolean) => void };

/**
 * Reserve before any transaction, in one atomic read/modify/write operation.
 * All workers for an operator must use the same file on persistent storage.
 * Missing configuration, corruption, I/O failure or a held lock fail closed.
 * A lock is never stolen on a timer: a paused writer must not overwrite a newer reservation.
 */
export function reservePublicRun(options: {
  file: string;
  visitor: string;
  hbar: number;
  budget: number;
  runsPerHour: number;
}): Reservation {
  if (!path.isAbsolute(options.file)) throw new Error("Public usage file must be an absolute persistent path");
  const id = randomUUID();
  const visitor = createHash("sha256").update(options.visitor).digest("hex");
  const result = update(options.file, ledger => {
    const now = Date.now();
    ledger.entries = ledger.entries.filter(entry => entry.at > now - HOUR_MS || entry.activeUntil > now);
    const own = ledger.entries.filter(entry => entry.visitor === visitor);
    if (own.some(entry => entry.activeUntil > now)) {
      return {
        code: "RUN_IN_PROGRESS",
        message: "Your previous run is still going",
        hint: "Wait for it to finish, then run again.",
      };
    }
    const spent = ledger.entries.reduce((sum, entry) => sum + entry.hbar, 0);
    if (spent + options.hbar > options.budget) {
      const minutes = Math.max(1, Math.ceil(((ledger.entries[0]?.at ?? now) + HOUR_MS - now) / 60_000));
      return {
        code: "PUBLIC_BUDGET_SPENT",
        message: "This demo's HBAR reservation budget for the hour is spent",
        hint: `It frees up in about ${minutes} minutes. You can also sign with your own testnet wallet.`,
      };
    }
    if (options.runsPerHour > 0 && own.length >= options.runsPerHour) {
      return {
        code: "RATE_LIMITED",
        message: `Run limit of ${options.runsPerHour} per hour reached`,
        hint: "Try again after an hour, or sign with your own wallet.",
      };
    }
    ledger.entries.push({ id, visitor, at: now, hbar: options.hbar, activeUntil: now + LEASE_MS });
    return null;
  });
  if (result) return { refused: result };
  let released = false;
  return {
    release: sentNothing => {
      if (released) return;
      // A failed release leaves the full reservation in place. Its lease expires; its budget does not reset.
      try {
        update(options.file, ledger => {
          const entry = ledger.entries.find(candidate => candidate.id === id);
          if (entry) {
            entry.activeUntil = 0;
            if (sentNothing) entry.hbar = 0;
          }
        });
        released = true;
      } catch {
        console.error("[launchblocks] Could not release public run lease; its reservation is retained");
      }
    },
  };
}

function update<T>(file: string, mutate: (ledger: Ledger) => T): T {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let ledger: Ledger = { version: 1, entries: [] };
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!validLedger(raw)) throw new Error("Invalid public budget ledger");
      ledger = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = mutate(ledger);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(ledger));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    // Persist the rename as well as the contents before returning permission to spend.
    const dir = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return result;
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed successfully, or failed before the temporary file existed.
    }
  }
}

function validLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Ledger;
  return (
    ledger.version === 1 &&
    Array.isArray(ledger.entries) &&
    ledger.entries.every(
      entry =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.visitor === "string" &&
        [entry.at, entry.hbar, entry.activeUntil].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0),
    )
  );
}
