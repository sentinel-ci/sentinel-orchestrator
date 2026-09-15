#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { addLabels, githubTargetFromEnv, openPromotionPr, postPrComment } from "./githubClient.js";
import { renderMarkdownReport } from "./reportGenerator.js";
import { runRetryLoop } from "./retryLoop.js";

interface PullRequestEvent {
  pull_request: { number: number; head: { ref: string } };
}

async function resolvePrNumber(): Promise<number> {
  if (process.env.SENTINEL_PR_NUMBER) return Number.parseInt(process.env.SENTINEL_PR_NUMBER, 10);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Neither SENTINEL_PR_NUMBER nor GITHUB_EVENT_PATH is set.");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as PullRequestEvent;
  return event.pull_request.number;
}

/**
 * Entry point run on the GitHub Actions runner (has network — needed for the
 * repair agent's Gemini calls and for posting back to the GitHub API). Wraps
 * the retry loop and turns its outcome into PR-visible actions.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const prNumber = await resolvePrNumber();
  const targetDir = resolve(process.env.SENTINEL_CHECKOUT_DIR ?? process.cwd());
  const orchestratorDir = resolve(process.env.SENTINEL_ORCHESTRATOR_DIR ?? process.cwd());
  const dockerfile = resolve(orchestratorDir, "sandbox", "Dockerfile");

  const history = await runRetryLoop({ prNumber, targetDir, dockerfile, orchestratorDir, config });
  const report = renderMarkdownReport(history);

  const github = githubTargetFromEnv();
  await postPrComment(github, prNumber, report);

  if (history.outcome === "passed") {
    const base = process.env.SENTINEL_PRODUCTION_BRANCH ?? "production";
    const head = process.env.SENTINEL_STAGING_BRANCH ?? "staging";
    try {
      const pr = await openPromotionPr(
        github,
        base,
        head,
        `Promote staging to ${base} (cleared Sentinel CI, PR #${prNumber})`,
        `Automated promotion after PR #${prNumber} cleared the Sentinel CI trust threshold.\n\n${report}`,
      );
      console.log(`Opened promotion PR: ${pr.html_url}`);
    } catch (err) {
      // A promotion PR may already exist, or staging==production with nothing
      // to promote yet — don't fail the whole run over that.
      console.warn(`Could not open promotion PR: ${(err as Error).message}`);
    }
  } else {
    await addLabels(github, prNumber, ["sentinel-blocked"]);
  }

  console.log(`Sentinel CI outcome for PR #${prNumber}: ${history.outcome}`);
  process.exit(history.outcome === "passed" ? 0 : 1);
}

main().catch((err) => {
  console.error("sentinel orchestrate crashed:", err);
  process.exit(1);
});
