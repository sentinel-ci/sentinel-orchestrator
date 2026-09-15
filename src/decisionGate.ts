export type GateDecision = "pass" | "repair" | "block";

/**
 * Pure threshold check: does this iteration clear the gate, and if not, is
 * there retry budget left? Side effects (PR comments, auto-PR, labels) are
 * handled by the caller based on this decision.
 */
export function decide(
  trustScore: number,
  threshold: number,
  iteration: number,
  maxIterations: number,
): GateDecision {
  if (trustScore >= threshold) return "pass";
  if (iteration < maxIterations) return "repair";
  return "block";
}
