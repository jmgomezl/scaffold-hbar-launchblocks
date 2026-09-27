// An independent process, to exercise the same file lock used by multiple app workers.
import { reservePublicRun } from "../../services/launchblocks/public-budget.ts";

try {
  const result = reservePublicRun({
    file: process.argv[2],
    visitor: process.argv[3],
    hbar: 10,
    budget: 10,
    runsPerHour: 20,
  });
  process.stdout.write("refused" in result ? "refused" : "reserved");
} catch {
  process.stdout.write("storage-busy");
}
