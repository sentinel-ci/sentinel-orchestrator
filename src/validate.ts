#!/usr/bin/env node
import { aggregateTrustScore } from "./aggregator.js";
import { loadConfig } from "./config.js";
import { decide } from "./decisionGate.js";
import { runMutationTesting } from "./mutationRunner.js";
import { runStaticAnalysis } from "./staticAnalysis.js";
import { emitEventLine } from "./telemetry.js";
import { runTests } from "./testRunner.js";
import type { ValidationReport } from "./types.js";

const ESLINT_FALLBACK_CONFIG = "/opt/sentinel/eslint.default.config.mjs";
const STRYKER_FALLBACK_CONFIG = "/opt/sentinel/stryker.default.config.json";

/**
 * Entry point run INSIDE the network-isolated sandbox container. Executes
 * one full validation pass (tests, lint, mutation testing) against the
 * target app and prints a single ValidationReport as JSON on the last
 * stdout line — the host-side orchestrator parses that line.
 *
 * Also writes `SENTINEL_EVENT:` marker lines to stdout at each phase
 * boundary. This container has no network (--network=none) and can't call
 * the dashboard itself; the host tails this process's stdout live and
 * relays these markers, which is how the dashboard gets near-real-time
 * progress without punching a hole in the sandbox's isolation.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const targetDir = process.argv[2] ?? config.targetDir;
  const iteration = Number.parseInt(process.env.SENTINEL_ITERATION ?? "0", 10);

  emitEventLine("tests", "start");
  const testResult = await runTests(targetDir);
  emitEventLine("tests", "end", testResult);

  emitEventLine("static_analysis", "start");
  const staticAnalysisResult = await runStaticAnalysis(targetDir, ESLINT_FALLBACK_CONFIG);
  emitEventLine("static_analysis", "end", staticAnalysisResult);

  emitEventLine("mutation", "start");
  const mutationResult = await runMutationTesting(targetDir, STRYKER_FALLBACK_CONFIG);
  emitEventLine("mutation", "end", mutationResult);

  const score = aggregateTrustScore(testResult, staticAnalysisResult, mutationResult, config.weights);
  const gate = decide(
    score.trustScore,
    config.promotionThreshold,
    iteration,
    config.maxIterations,
    testResult.failed > 0,
  );
  emitEventLine("aggregate", "end", score);

  const report: ValidationReport = {
    iteration,
    timestamp: new Date().toISOString(),
    testResult,
    staticAnalysisResult,
    mutationResult,
    score,
    passedGate: gate === "pass",
    threshold: config.promotionThreshold,
  };

  // Marker line makes this robust to any stray stdout noise from the tools above.
  process.stdout.write(`SENTINEL_REPORT_JSON:${JSON.stringify(report)}\n`);
}

main().catch((err) => {
  console.error("sentinel validate crashed:", err);
  process.exit(1);
});
