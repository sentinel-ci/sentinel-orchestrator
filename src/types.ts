export interface TestFailure {
  name: string;
  message: string;
}

export interface TestRunResult {
  passed: number;
  failed: number;
  total: number;
  failures: TestFailure[];
  /** Raw stdout/stderr tail, kept for the human-readable report. */
  rawOutputTail: string;
}

export interface LintIssue {
  file: string;
  line: number;
  message: string;
  ruleId: string | null;
  severity: "error" | "warning";
}

export interface StaticAnalysisResult {
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

export interface SurvivedMutant {
  file: string;
  line: number;
  mutatorName: string;
  description: string;
}

export interface MutationRunResult {
  mutationScore: number; // 0-100, or -1 if mutation testing could not run
  killed: number;
  survived: number;
  totalMutants: number;
  survivedMutants: SurvivedMutant[];
  skipped: boolean;
  skipReason?: string;
}

export interface TrustScoreBreakdown {
  unitTestPassRate: number; // 0-100
  mutationScore: number; // 0-100
  staticAnalysisCleanliness: number; // 0-100
  weightedContributions: {
    unitTests: number;
    mutation: number;
    staticAnalysis: number;
  };
  trustScore: number; // 0-100
}

export interface ValidationReport {
  iteration: number;
  timestamp: string;
  testResult: TestRunResult;
  staticAnalysisResult: StaticAnalysisResult;
  mutationResult: MutationRunResult;
  score: TrustScoreBreakdown;
  passedGate: boolean;
  threshold: number;
}

export interface GeneratedTest {
  /** Path (relative to the target app root) the test file was written to. */
  path: string;
  /** Path (relative to the target app root) of the source file this test targets. */
  sourceFile: string;
  content: string;
  /** Set if generation succeeded but the file couldn't be written/parsed as expected. */
  error?: string;
}

export interface TestGenReport {
  timestamp: string;
  model: string;
  /** Source files Alice was asked to cover (the PR's changed production files). */
  targetFiles: string[];
  generatedTests: GeneratedTest[];
}

export interface FileDiff {
  path: string;
  diff: string;
}

export interface RepairAttempt {
  iteration: number;
  timestamp: string;
  prompt: string;
  model: string;
  /** Bob's own one-line-ish explanation of what he changed and why — surfaced as-is in the report/dashboard. */
  summary?: string;
  filesChanged: string[];
  /** Per-file diffs for files that actually changed (files Bob echoed back unmodified are filtered out before this point). */
  fileDiffs: FileDiff[];
  /** All of fileDiffs concatenated — kept for the markdown report / anything that just wants one blob. */
  diff: string;
  rawResponse: string;
  applied: boolean;
  error?: string;
}

export interface IterationRecord {
  iteration: number;
  validation: ValidationReport;
  repair?: RepairAttempt;
}

export interface RunHistory {
  prNumber: number | string;
  startedAt: string;
  finishedAt?: string;
  outcome: "passed" | "blocked" | "in_progress";
  /** Alice's output, if test generation ran (once, before the first iteration). */
  testGen?: TestGenReport;
  iterations: IterationRecord[];
}
