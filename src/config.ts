/**
 * All tunables live here and are env-driven so the formula/threshold/budget
 * can change without touching code. See README "Open Design Decisions" for
 * the rationale behind each default.
 */

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

export interface TrustScoreWeights {
  unitTestPassRate: number;
  mutationScore: number;
  staticAnalysisCleanliness: number;
}

export interface SentinelConfig {
  /** Weighted trust score formula inputs. Must sum to 1.0. */
  weights: TrustScoreWeights;
  /** Trust score (0-100) required to clear the gate. */
  promotionThreshold: number;
  /** Max repair iterations before giving up and blocking the PR. */
  maxIterations: number;
  /** Whether the repair agent may edit files under the configured test dirs. */
  allowTestEdits: boolean;
  /** Anthropic model used for repair. */
  repairModel: string;
  /** Directory (relative to the target app root) treated as test code. */
  testDirs: string[];
  /** Where the target app source lives, mounted/copied into the sandbox. */
  targetDir: string;
  /** Where per-iteration run artifacts are written. */
  runsDir: string;
}

export function loadConfig(): SentinelConfig {
  const weights: TrustScoreWeights = {
    unitTestPassRate: envFloat("SENTINEL_WEIGHT_UNIT_TESTS", 0.4),
    mutationScore: envFloat("SENTINEL_WEIGHT_MUTATION", 0.4),
    staticAnalysisCleanliness: envFloat("SENTINEL_WEIGHT_STATIC_ANALYSIS", 0.2),
  };

  const weightSum =
    weights.unitTestPassRate + weights.mutationScore + weights.staticAnalysisCleanliness;
  if (Math.abs(weightSum - 1) > 0.001) {
    throw new Error(
      `Trust score weights must sum to 1.0, got ${weightSum.toFixed(3)} ` +
        `(unitTests=${weights.unitTestPassRate}, mutation=${weights.mutationScore}, ` +
        `staticAnalysis=${weights.staticAnalysisCleanliness})`,
    );
  }

  return {
    weights,
    promotionThreshold: envFloat("SENTINEL_PROMOTION_THRESHOLD", 75),
    maxIterations: envInt("SENTINEL_MAX_ITERATIONS", 3),
    allowTestEdits: (process.env.SENTINEL_ALLOW_TEST_EDITS ?? "false") === "true",
    repairModel: process.env.SENTINEL_REPAIR_MODEL ?? "claude-sonnet-5",
    testDirs: (process.env.SENTINEL_TEST_DIRS ?? "tests,test,__tests__")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    targetDir: process.env.SENTINEL_TARGET_DIR ?? "/target",
    runsDir: process.env.SENTINEL_RUNS_DIR ?? "./sentinel-runs",
  };
}
