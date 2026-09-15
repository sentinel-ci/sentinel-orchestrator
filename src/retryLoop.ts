import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SentinelConfig } from "./config.js";
import { decide } from "./decisionGate.js";
import { renderJsonArtifact, renderMarkdownReport } from "./reportGenerator.js";
import { runRepair } from "./repairAgent.js";
import { buildSandboxImage, runValidationInSandbox } from "./sandbox.js";
import type { IterationRecord, RunHistory } from "./types.js";

export interface RetryLoopOptions {
  prNumber: number | string;
  targetDir: string;
  dockerfile: string;
  /** Root of the sentinel-orchestrator repo (the "sentinel" build context). */
  orchestratorDir: string;
  config: SentinelConfig;
}

/**
 * Bounded validate -> repair -> re-validate loop. Never runs unbounded:
 * `decide()` forces "block" once `iteration >= maxIterations`, and each
 * iteration always advances the counter regardless of outcome.
 *
 * The container is rebuilt each iteration (Docker layer caching keeps this
 * cheap since only the final COPY layers invalidate) rather than kept alive
 * across iterations — see README "same sandbox instance" for why a literal
 * long-lived container is incompatible with --network=none once the repair
 * step needs outbound access to call Claude.
 */
export async function runRetryLoop(options: RetryLoopOptions): Promise<RunHistory> {
  const { prNumber, targetDir, dockerfile, orchestratorDir, config } = options;
  const history: RunHistory = {
    prNumber,
    startedAt: new Date().toISOString(),
    outcome: "in_progress",
    iterations: [],
  };

  const runDir = join(config.runsDir, String(prNumber));
  await mkdir(runDir, { recursive: true });

  for (let iteration = 0; iteration <= config.maxIterations; iteration += 1) {
    const tag = `sentinel-sandbox:${prNumber}-${iteration}`;
    await buildSandboxImage({
      dockerfile,
      contexts: { target: targetDir, sentinel: orchestratorDir },
      tag,
    });

    const validation = await runValidationInSandbox(tag, iteration);
    const record: IterationRecord = { iteration, validation };

    const gate = decide(validation.score.trustScore, config.promotionThreshold, iteration, config.maxIterations);

    if (gate === "pass") {
      history.iterations.push(record);
      history.outcome = "passed";
      break;
    }

    if (gate === "block") {
      history.iterations.push(record);
      history.outcome = "blocked";
      break;
    }

    // gate === "repair": attempt a fix and loop again.
    const repair = await runRepair(targetDir, validation, config, iteration);
    record.repair = repair;
    history.iterations.push(record);

    await writeFile(join(runDir, `iteration-${iteration}.json`), JSON.stringify(record, null, 2), "utf8");

    if (!repair.applied) {
      // Repair couldn't produce a usable patch; no point burning further
      // iterations against an unchanged codebase.
      history.outcome = "blocked";
      break;
    }
  }

  history.finishedAt = new Date().toISOString();
  if (history.outcome === "in_progress") history.outcome = "blocked";

  await writeFile(join(runDir, "history.json"), renderJsonArtifact(history), "utf8");
  await writeFile(join(runDir, "report.md"), renderMarkdownReport(history), "utf8");

  return history;
}
