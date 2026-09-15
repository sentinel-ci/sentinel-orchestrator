import type { TrustScoreWeights } from "./config.js";
import type {
  MutationRunResult,
  StaticAnalysisResult,
  TestRunResult,
  TrustScoreBreakdown,
} from "./types.js";

function clamp0to100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Combines the three raw signals into a single 0-100 trust score using the
 * configured weighted formula (default 0.4 / 0.4 / 0.2 — see README).
 *
 * If mutation testing was skipped (tooling failure, not a quality signal),
 * its weight is redistributed proportionally across the remaining signals
 * rather than scored as 0 — a sandbox/tooling problem shouldn't tank a PR's
 * trust score the same way a genuinely weak test suite would.
 */
export function aggregateTrustScore(
  testResult: TestRunResult,
  staticAnalysisResult: StaticAnalysisResult,
  mutationResult: MutationRunResult,
  weights: TrustScoreWeights,
): TrustScoreBreakdown {
  const unitTestPassRate = testResult.total === 0 ? 0 : (testResult.passed / testResult.total) * 100;

  const lintTotal = staticAnalysisResult.errors + staticAnalysisResult.warnings;
  // Errors count double against cleanliness — a lint error is a much stronger
  // signal than a style warning.
  const penaltyWeight = staticAnalysisResult.errors * 2 + staticAnalysisResult.warnings;
  const staticAnalysisCleanliness =
    lintTotal === 0 ? 100 : clamp0to100(100 - penaltyWeight * 5);

  const mutationAvailable = !mutationResult.skipped && mutationResult.mutationScore >= 0;
  const mutationScore = mutationAvailable ? mutationResult.mutationScore : 0;

  let effectiveWeights = weights;
  if (!mutationAvailable) {
    const remaining = weights.unitTestPassRate + weights.staticAnalysisCleanliness;
    effectiveWeights = {
      unitTestPassRate: remaining === 0 ? 0 : weights.unitTestPassRate / remaining,
      mutationScore: 0,
      staticAnalysisCleanliness: remaining === 0 ? 0 : weights.staticAnalysisCleanliness / remaining,
    };
  }

  const weightedContributions = {
    unitTests: unitTestPassRate * effectiveWeights.unitTestPassRate,
    mutation: mutationScore * effectiveWeights.mutationScore,
    staticAnalysis: staticAnalysisCleanliness * effectiveWeights.staticAnalysisCleanliness,
  };

  const trustScore = clamp0to100(
    weightedContributions.unitTests + weightedContributions.mutation + weightedContributions.staticAnalysis,
  );

  return {
    unitTestPassRate,
    mutationScore,
    staticAnalysisCleanliness,
    weightedContributions,
    trustScore,
  };
}
