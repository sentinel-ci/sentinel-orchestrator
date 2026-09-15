#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  addLabels,
  githubTargetFromEnv,
  listChangedFiles,
  openPromotionPr,
  postPrComment,
  updatePrComment,
} from "./githubClient.js";
import { renderMarkdownReport } from "./reportGenerator.js";
import { runRetryLoop } from "./retryLoop.js";
import { isTestFile } from "./sourceFiles.js";
import { createDashboardRun } from "./telemetry.js";

interface PullRequestEvent {
  pull_request: { number: number; title?: string; html_url?: string; head: { ref: string } };
}

interface PrContext {
  number: number;
  title?: string;
  url?: string;
}

async function resolvePrContext(): Promise<PrContext> {
  if (process.env.SENTINEL_PR_NUMBER) {
    return { number: Number.parseInt(process.env.SENTINEL_PR_NUMBER, 10) };
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Neither SENTINEL_PR_NUMBER nor GITHUB_EVENT_PATH is set.");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as PullRequestEvent;
  return { number: event.pull_request.number, title: event.pull_request.title, url: event.pull_request.html_url };
}

/** Appends to the GitHub Actions run's own summary page, so the live dashboard link is visible there too — not just in the PR comment — while a run is still in progress. No-op outside Actions (env var unset). */
async function writeJobSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  await appendFile(summaryPath, `${markdown}\n`, "utf8").catch(() => {});
}

/**
 * Entry point run on the GitHub Actions runner (has network — needed for the
 * repair agent's Gemini calls and for posting back to the GitHub API). Wraps
 * the retry loop and turns its outcome into PR-visible actions.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pr = await resolvePrContext();
  const targetDir = resolve(process.env.SENTINEL_CHECKOUT_DIR ?? process.cwd());
  const orchestratorDir = resolve(process.env.SENTINEL_ORCHESTRATOR_DIR ?? process.cwd());
  const dockerfile = resolve(orchestratorDir, "sandbox", "Dockerfile");

  const github = githubTargetFromEnv();

  const changedFiles = await listChangedFiles(github, pr.number).catch((err) => {
    console.warn(`Could not list changed files (falling back to unscoped test-gen/mutation): ${(err as Error).message}`);
    return [];
  });
  const changedProductionFiles = changedFiles
    .filter((f) => f.status !== "removed")
    .map((f) => f.filename)
    .filter((f) => /\.(js|jsx|ts|tsx)$/.test(f) && !isTestFile(f, config.testDirs));

  const dashboardRun = await createDashboardRun(config, {
    repo: `${github.owner}/${github.repo}`,
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
  });

  let liveCommentId: number | undefined;
  if (dashboardRun) {
    const { id } = await postPrComment(
      github,
      pr.number,
      `## \u{1F50D} Sentinel CI started\n\n[Watch this run live](${dashboardRun.url}) — updates as each phase completes, no need to refresh.`,
    );
    liveCommentId = id;
    await writeJobSummary(`### 🔍 Sentinel CI\n\n[Watch this run live](${dashboardRun.url})\n`);
  }

  const history = await runRetryLoop({
    prNumber: pr.number,
    targetDir,
    dockerfile,
    orchestratorDir,
    config,
    dashboardRunId: dashboardRun?.runId,
    changedProductionFiles,
  });

  const report =
    (dashboardRun ? `[Full live run](${dashboardRun.url})\n\n` : "") + renderMarkdownReport(history);

  if (liveCommentId) {
    await updatePrComment(github, liveCommentId, report);
  } else {
    await postPrComment(github, pr.number, report);
  }

  if (dashboardRun) {
    await writeJobSummary(
      `\n### Result: ${history.outcome === "passed" ? "✅ passed" : "❌ blocked"}\n\n[Full live run](${dashboardRun.url})\n`,
    );
  }

  if (history.outcome === "passed") {
    const base = process.env.SENTINEL_PRODUCTION_BRANCH ?? "production";
    const head = process.env.SENTINEL_STAGING_BRANCH ?? "staging";
    try {
      const promotionPr = await openPromotionPr(
        github,
        base,
        head,
        `Promote staging to ${base} (cleared Sentinel CI, PR #${pr.number})`,
        `Automated promotion after PR #${pr.number} cleared the Sentinel CI trust threshold.\n\n${report}`,
      );
      console.log(`Opened promotion PR: ${promotionPr.html_url}`);
    } catch (err) {
      // A promotion PR may already exist, or staging==production with nothing
      // to promote yet — don't fail the whole run over that.
      console.warn(`Could not open promotion PR: ${(err as Error).message}`);
    }
  } else {
    await addLabels(github, pr.number, ["sentinel-blocked"]);
  }

  console.log(`Sentinel CI outcome for PR #${pr.number}: ${history.outcome}`);
  process.exit(history.outcome === "passed" ? 0 : 1);
}

main().catch((err) => {
  console.error("sentinel orchestrate crashed:", err);
  process.exit(1);
});
