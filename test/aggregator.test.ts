import { describe, expect, it } from "vitest";
import { aggregateTrustScore } from "../src/aggregator.js";
import type { MutationRunResult, StaticAnalysisResult, TestRunResult } from "../src/types.js";

const weights = { unitTestPassRate: 0.4, mutationScore: 0.4, staticAnalysisCleanliness: 0.2 };

function tests(passed: number, total: number): TestRunResult {
  return { passed, failed: total - passed, total, failures: [], rawOutputTail: "" };
}

function lint(errors: number, warnings: number): StaticAnalysisResult {
  return { errors, warnings, issues: [] };
}

function mutation(score: number, killed = 8, survived = 2): MutationRunResult {
  return { mutationScore: score, killed, survived, totalMutants: killed + survived, survivedMutants: [], skipped: false };
}

describe("aggregateTrustScore", () => {
  it("is deterministic for identical inputs", () => {
    const a = aggregateTrustScore(tests(9, 10), lint(0, 0), mutation(80), weights);
    const b = aggregateTrustScore(tests(9, 10), lint(0, 0), mutation(80), weights);
    expect(a).toEqual(b);
  });

  it("scores a perfect run at 100", () => {
    const score = aggregateTrustScore(tests(10, 10), lint(0, 0), mutation(100, 10, 0), weights);
    expect(score.trustScore).toBeCloseTo(100, 5);
  });

  it("scores a fully broken run at 0", () => {
    const score = aggregateTrustScore(tests(0, 10), lint(10, 0), mutation(0, 0, 10), weights);
    expect(score.trustScore).toBeCloseTo(0, 5);
  });

  it("weights unit tests, mutation and static analysis independently", () => {
    // Zero out mutation and static analysis so only the unit-test term contributes.
    const testsOnly = aggregateTrustScore(tests(10, 10), lint(50, 0), mutation(0, 0, 10), weights);
    // unitTests weight 0.4 * 100 = 40
    expect(testsOnly.trustScore).toBeCloseTo(40, 5);
  });

  it("redistributes weight away from mutation when mutation testing is skipped", () => {
    const skipped: MutationRunResult = {
      mutationScore: -1,
      killed: 0,
      survived: 0,
      totalMutants: 0,
      survivedMutants: [],
      skipped: true,
      skipReason: "tooling unavailable",
    };
    const score = aggregateTrustScore(tests(10, 10), lint(0, 0), skipped, weights);
    // unit tests (0.4) + static analysis (0.2) renormalized to sum to 1 -> both 100 -> trustScore 100
    expect(score.trustScore).toBeCloseTo(100, 5);
  });

  it("weights lint errors more heavily than warnings", () => {
    const errorHeavy = aggregateTrustScore(tests(10, 10), lint(2, 0), mutation(100, 10, 0), weights);
    const warningHeavy = aggregateTrustScore(tests(10, 10), lint(0, 2), mutation(100, 10, 0), weights);
    expect(errorHeavy.trustScore).toBeLessThan(warningHeavy.trustScore);
  });

  it("never returns a score outside [0, 100]", () => {
    const score = aggregateTrustScore(tests(0, 10), lint(50, 50), mutation(0, 0, 100), weights);
    expect(score.trustScore).toBeGreaterThanOrEqual(0);
    expect(score.trustScore).toBeLessThanOrEqual(100);
  });
});
