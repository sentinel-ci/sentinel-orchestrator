import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, tail } from "./exec.js";
import type { TestFailure, TestRunResult } from "./types.js";

interface JestAssertionResult {
  status: "passed" | "failed" | "pending" | "skipped" | "todo";
  fullName: string;
  failureMessages: string[];
}

interface JestTestResult {
  assertionResults: JestAssertionResult[];
  /** Non-empty when the whole suite failed before any test ran (require error, syntax error, etc.) — the individual assertionResults list is empty in that case, so this is the only place the failure shows up. */
  message?: string;
  testFilePath?: string;
}

interface JestAggregatedResult {
  numPassedTests: number;
  numFailedTests: number;
  numTotalTests: number;
  testResults: JestTestResult[];
}

/**
 * Runs the target app's test suite (Jest) and returns structured pass/fail data.
 * v1 assumes Jest, since it's what the demo app uses; swapping runners means
 * adding a sibling adapter and selecting it in `runTests` based on the target's
 * package.json devDependencies.
 */
export async function runTests(targetDir: string): Promise<TestRunResult> {
  const outDir = await mkdtemp(join(tmpdir(), "sentinel-jest-"));
  const outputFile = join(outDir, "jest-results.json");

  try {
    const result = await runCommand(
      "npm",
      ["test", "--silent", "--", "--json", `--outputFile=${outputFile}`],
      { cwd: targetDir, timeoutMs: 5 * 60 * 1000 },
    );

    let parsed: JestAggregatedResult | null = null;
    try {
      const raw = await readFile(outputFile, "utf8");
      parsed = JSON.parse(raw) as JestAggregatedResult;
    } catch {
      parsed = null;
    }

    if (!parsed) {
      // Test run crashed before producing JSON (e.g. syntax error, missing deps).
      return {
        passed: 0,
        failed: 1,
        total: 1,
        failures: [
          {
            name: "test suite",
            message: tail(result.stderr || result.stdout || "Test run produced no output.", 2000),
          },
        ],
        rawOutputTail: tail(result.stdout + "\n" + result.stderr),
      };
    }

    const failures: TestFailure[] = [];
    let crashedSuites = 0;
    for (const testResult of parsed.testResults) {
      for (const assertion of testResult.assertionResults) {
        if (assertion.status === "failed") {
          failures.push({
            name: assertion.fullName,
            message: tail(assertion.failureMessages.join("\n"), 1000),
          });
        }
      }
      // A suite that fails before any test runs (require error, syntax error)
      // contributes zero to numTotalTests and has no assertionResults, so
      // without this it's completely invisible to the trust score, the
      // hasFailingTests gate, and Bob's repair context alike — confirmed for
      // real: Alice generated a test with a wrong import path, the suite
      // crashed, and the report showed a clean-looking "0/0 tests" with no
      // indication anything was wrong.
      if (testResult.assertionResults.length === 0 && testResult.message) {
        crashedSuites += 1;
        failures.push({
          name: testResult.testFilePath ?? "test suite",
          message: tail(testResult.message, 1500),
        });
      }
    }

    return {
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests + crashedSuites,
      total: parsed.numTotalTests + crashedSuites,
      failures,
      rawOutputTail: tail(result.stdout + "\n" + result.stderr),
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
