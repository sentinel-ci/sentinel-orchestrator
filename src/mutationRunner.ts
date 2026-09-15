import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./exec.js";
import type { MutationRunResult, SurvivedMutant } from "./types.js";

interface StrykerMutant {
  id: string;
  mutatorName: string;
  status: string;
  description?: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

interface StrykerFile {
  mutants: StrykerMutant[];
}

interface StrykerReport {
  files: Record<string, StrykerFile>;
}

const KILLED_STATUSES = new Set(["Killed", "Timeout"]);
const SURVIVED_STATUSES = new Set(["Survived", "NoCoverage"]);
// Ignored/CompileError/RuntimeError mutants don't tell us anything about test
// quality, so they're excluded from both the numerator and the denominator.

/**
 * Runs StrykerJS against the target app and derives a mutation score plus the
 * list of survived mutants — the key signal for "this test suite wouldn't
 * actually catch a real bug."
 */
export async function runMutationTesting(
  targetDir: string,
  fallbackConfigPath: string,
): Promise<MutationRunResult> {
  const configArg = (await hasOwnConfig(targetDir)) ? [] : [fallbackConfigPath];

  const versionCheck = await runCommand("npx", ["--yes", "stryker", "--version"], {
    cwd: targetDir,
    timeoutMs: 60_000,
  }).catch(() => null);

  if (!versionCheck || versionCheck.code !== 0) {
    return {
      mutationScore: -1,
      killed: 0,
      survived: 0,
      totalMutants: 0,
      survivedMutants: [],
      skipped: true,
      skipReason: "StrykerJS is not available in the sandbox image.",
    };
  }

  await runCommand("npx", ["--yes", "stryker", "run", ...configArg], {
    cwd: targetDir,
    timeoutMs: 10 * 60 * 1000,
  }).catch(() => null); // Stryker exits non-zero when the score is below its own
  // internal threshold; we read the report regardless and derive our own score.

  const reportPath = join(targetDir, "reports", "mutation", "mutation.json");
  let report: StrykerReport;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as StrykerReport;
  } catch {
    return {
      mutationScore: -1,
      killed: 0,
      survived: 0,
      totalMutants: 0,
      survivedMutants: [],
      skipped: true,
      skipReason: "Stryker did not produce a mutation report (likely a config or runner crash).",
    };
  }

  let killed = 0;
  let survived = 0;
  const survivedMutants: SurvivedMutant[] = [];

  for (const [filePath, file] of Object.entries(report.files)) {
    for (const mutant of file.mutants) {
      if (KILLED_STATUSES.has(mutant.status)) {
        killed += 1;
      } else if (SURVIVED_STATUSES.has(mutant.status)) {
        survived += 1;
        survivedMutants.push({
          file: filePath,
          line: mutant.location.start.line,
          mutatorName: mutant.mutatorName,
          description: mutant.description ?? mutant.mutatorName,
        });
      }
      // other statuses (Ignored, CompileError, RuntimeError, Pending) excluded
    }
  }

  const totalValid = killed + survived;
  const mutationScore = totalValid === 0 ? 100 : (killed / totalValid) * 100;

  return {
    mutationScore,
    killed,
    survived,
    totalMutants: totalValid,
    survivedMutants,
    skipped: false,
  };
}

async function hasOwnConfig(targetDir: string): Promise<boolean> {
  for (const candidate of ["stryker.conf.json", "stryker.conf.js", "stryker.config.json"]) {
    try {
      await access(join(targetDir, candidate));
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
