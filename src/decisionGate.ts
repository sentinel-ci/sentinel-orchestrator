export type GateDecision = "pass" | "repair" | "block";

/**
 * Threshold check: does this iteration clear the gate, and if not, is there
 * retry budget left? Side effects (PR comments, auto-PR, labels) are
 * handled by the caller based on this decision.
 *
 * `hasFailingTests` is a hard override: a run with any literally failing
 * test can never "pass", regardless of trust score. Without this, a PR with
 * a real regression can still clear the threshold on a blended score alone
 * — and it isn't a rare edge case: StrykerJS refuses to run mutation testing
 * at all when the baseline test run has failures (a broken baseline makes
 * "did the mutant survive" meaningless), so mutation testing is skipped on
 * *every* PR with a failing test. That skip redistributes its weight onto
 * unit-test-pass-rate + static analysis, making the blended score even more
 * forgiving in exactly the case where it should be least forgiving.
 * Confirmed empirically: a demo run with 17/18 tests passing and clean lint
 * scored 96.3/100 — comfortably above a 75 threshold — despite one test
 * failing on a real, deliberately-introduced bug.
 */
export function decide(
  trustScore: number,
  threshold: number,
  iteration: number,
  maxIterations: number,
  hasFailingTests: boolean,
): GateDecision {
  const clearsThreshold = trustScore >= threshold && !hasFailingTests;
  if (clearsThreshold) return "pass";
  if (iteration < maxIterations) return "repair";
  return "block";
}
