import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTestGeneration } from "./aliceAgent.js";
import type { SentinelConfig } from "./config.js";
import { decide } from "./decisionGate.js";
import { renderJsonArtifact, renderMarkdownReport } from "./reportGenerator.js";
import { runRepair } from "./repairAgent.js";
import { buildSandboxImage, runValidationInSandbox } from "./sandbox.js";
import { finishDashboardRun, parseEventLine, postDashboardEvent } from "./telemetry.js";
import type { IterationRecord, RunHistory } from "./types.js";

export interface RetryLoopOptions {
  prNumber: number | string;
  targetDir: string;
  dockerfile: string;
  /** Root of the sentinel-orchestrator repo (the "sentinel" build context). */
  orchestratorDir: string;
  config: SentinelConfig;
  /** sentinel-dashboard run id, if a dashboard is configured (see telemetry.ts) — omit to skip all live reporting. */
  dashboardRunId?: string;
  /** Production (non-test) files changed in the PR, relative to targetDir — drives Alice's scope and mutation-testing's scope. Empty/undefined means "no diff info," which mutation testing treats as "use the broad fallback config" rather than "nothing changed." */
  changedProductionFiles?: string[];
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
 * step needs outbound access to call Gemini.
 */
export async function runRetryLoop(options: RetryLoopOptions): Promise<RunHistory> {
  const { prNumber, targetDir, dockerfile, orchestratorDir, config, dashboardRunId, changedProductionFiles } = options;
  const history: RunHistory = {
    prNumber,
    startedAt: new Date().toISOString(),
    outcome: "in_progress",
    iterations: [],
  };

  const runDir = join(config.runsDir, String(prNumber));
  await mkdir(runDir, { recursive: true });

  // Alice runs once, before the first iteration — she writes new test files
  // for the PR's changed production files, which then get exercised by every
  // subsequent iteration same as any pre-existing test.
  if (config.enableTestGeneration && changedProductionFiles && changedProductionFiles.length > 0) {
    await postDashboardEvent(config, dashboardRunId, { type: "phase_start", iteration: 0, phase: "test_generation" });
    const testGen = await runTestGeneration(targetDir, changedProductionFiles, config);
    history.testGen = testGen;
    await postDashboardEvent(config, dashboardRunId, {
      type: "phase_end",
      iteration: 0,
      phase: "test_generation",
      data: testGen,
    });
  }

  const sandboxEnv: Record<string, string> = {};
  if (changedProductionFiles && changedProductionFiles.length > 0) {
    sandboxEnv.SENTINEL_CHANGED_FILES = changedProductionFiles.join(",");
  }

  for (let iteration = 0; iteration <= config.maxIterations; iteration += 1) {
    const tag = `sentinel-sandbox:${prNumber}-${iteration}`;

    await postDashboardEvent(config, dashboardRunId, { type: "phase_start", iteration, phase: "build" });
    await buildSandboxImage({
      dockerfile,
      contexts: { target: targetDir, sentinel: orchestratorDir },
      tag,
    });
    await postDashboardEvent(config, dashboardRunId, { type: "phase_end", iteration, phase: "build" });

    // The sandbox container has no network of its own, so it can only report
    // progress by writing SENTINEL_EVENT: marker lines to stdout — relay
    // those to the dashboard as they arrive rather than waiting for the
    // container to exit.
    const validation = await runValidationInSandbox(tag, iteration, sandboxEnv, (line) => {
      const parsed = parseEventLine(line);
      if (!parsed) return;
      void postDashboardEvent(config, dashboardRunId, {
        type: parsed.kind === "start" ? "phase_start" : "phase_end",
        iteration,
        phase: parsed.phase,
        data: parsed.data,
      });
    });
    const record: IterationRecord = { iteration, validation };

    const gate = decide(
      validation.score.trustScore,
      config.promotionThreshold,
      iteration,
      config.maxIterations,
      validation.testResult.failed > 0,
    );

    if (gate === "pass") {
      history.iterations.push(record);
      history.outcome = "passed";
      await postDashboardEvent(config, dashboardRunId, { type: "iteration_complete", iteration });
      break;
    }

    if (gate === "block") {
      history.iterations.push(record);
      history.outcome = "blocked";
      await postDashboardEvent(config, dashboardRunId, { type: "iteration_complete", iteration });
      break;
    }

    // gate === "repair": attempt a fix and loop again.
    await postDashboardEvent(config, dashboardRunId, { type: "repair_start", iteration });
    const repair = await runRepair(targetDir, validation, config, iteration);
    record.repair = repair;
    history.iterations.push(record);
    await postDashboardEvent(config, dashboardRunId, {
      type: "repair_end",
      iteration,
      data: { model: repair.model, applied: repair.applied, filesChanged: repair.filesChanged, diff: repair.diff, error: repair.error },
    });
    await postDashboardEvent(config, dashboardRunId, { type: "iteration_complete", iteration });

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

  await finishDashboardRun(config, dashboardRunId, history.outcome === "passed" ? "passed" : "blocked");

  return history;
}
