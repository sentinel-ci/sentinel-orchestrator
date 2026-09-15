import { describe, expect, it } from "vitest";
import { renderJsonArtifact, renderMarkdownReport } from "../src/reportGenerator.js";
import type { RunHistory, ValidationReport } from "../src/types.js";

function makeValidation(trustScore: number): ValidationReport {
  return {
    iteration: 0,
    timestamp: new Date().toISOString(),
    testResult: { passed: 8, failed: 2, total: 10, failures: [{ name: "adds numbers", message: "expected 4 got 5" }], rawOutputTail: "" },
    staticAnalysisResult: { errors: 1, warnings: 2, issues: [{ file: "src/a.js", line: 3, message: "unused var", ruleId: "no-unused-vars", severity: "warning" }] },
    mutationResult: {
      mutationScore: 60,
      killed: 6,
      survived: 4,
      totalMutants: 10,
      survivedMutants: [{ file: "src/a.js", line: 10, mutatorName: "ConditionalExpression", description: "flipped condition" }],
      skipped: false,
    },
    score: {
      unitTestPassRate: 80,
      mutationScore: 60,
      staticAnalysisCleanliness: 70,
      weightedContributions: { unitTests: 32, mutation: 24, staticAnalysis: 14 },
      trustScore,
    },
    passedGate: trustScore >= 75,
    threshold: 75,
  };
}

describe("renderMarkdownReport", () => {
  it("produces valid, non-empty markdown for a passing run", () => {
    const history: RunHistory = {
      prNumber: 42,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: "passed",
      iterations: [{ iteration: 0, validation: makeValidation(90) }],
    };
    const md = renderMarkdownReport(history);
    expect(md).toContain("cleared");
    expect(md).toContain("Trust score");
    expect(md).toContain("90.0");
  });

  it("includes repair diffs on later iterations", () => {
    const history: RunHistory = {
      prNumber: 7,
      startedAt: new Date().toISOString(),
      outcome: "blocked",
      iterations: [
        {
          iteration: 0,
          validation: makeValidation(40),
          repair: {
            iteration: 0,
            timestamp: new Date().toISOString(),
            prompt: "fix it",
            model: "claude-sonnet-5",
            filesChanged: ["src/a.js"],
            diff: "--- a/src/a.js\n+++ b/src/a.js\n-old\n+new",
            rawResponse: "{}",
            applied: true,
          },
        },
      ],
    };
    const md = renderMarkdownReport(history);
    expect(md).toContain("blocked");
    expect(md).toContain("Repair attempt");
    expect(md).toContain("src/a.js");
  });

  it("survives an empty iteration list", () => {
    const history: RunHistory = { prNumber: 1, startedAt: new Date().toISOString(), outcome: "in_progress", iterations: [] };
    expect(() => renderMarkdownReport(history)).not.toThrow();
  });
});

describe("renderJsonArtifact", () => {
  it("round-trips through JSON", () => {
    const history: RunHistory = {
      prNumber: 3,
      startedAt: new Date().toISOString(),
      outcome: "passed",
      iterations: [{ iteration: 0, validation: makeValidation(80) }],
    };
    const parsed = JSON.parse(renderJsonArtifact(history)) as RunHistory;
    expect(parsed.prNumber).toBe(3);
    expect(parsed.iterations[0].validation.score.trustScore).toBe(80);
  });
});
