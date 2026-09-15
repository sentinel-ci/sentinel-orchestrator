import { createTwoFilesPatch } from "diff";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SentinelConfig } from "./config.js";
import { callGemini } from "./gemini.js";
import { isTestFile, listSourceFiles, readFileSafe } from "./sourceFiles.js";
import type { RepairAttempt, ValidationReport } from "./types.js";

interface ProposedChange {
  path: string;
  content: string;
}

interface RepairResponse {
  summary: string;
  changes: ProposedChange[];
}

function buildPrompt(validation: ValidationReport, fileContents: Map<string, string>): string {
  const parts: string[] = [];
  parts.push(
    "You are the repair step in an automated CI pipeline. The change below failed to clear " +
      `a trust threshold of ${validation.threshold}/100 (scored ${validation.score.trustScore.toFixed(1)}/100).`,
  );
  parts.push(
    "Fix the underlying code so the tests genuinely pass and, where mutants survived, so the " +
      "logic actually behaves correctly (do not just special-case the test inputs).",
  );
  parts.push("You may ONLY modify the production source files shown below. Do not invent new files.");
  parts.push("");

  if (validation.testResult.failures.length > 0) {
    parts.push("## Failing tests");
    for (const f of validation.testResult.failures.slice(0, 15)) {
      parts.push(`- ${f.name}: ${f.message}`);
    }
    parts.push("");
  }

  if (validation.mutationResult.survivedMutants.length > 0) {
    parts.push("## Survived mutants (tests failed to catch these injected faults)");
    for (const m of validation.mutationResult.survivedMutants.slice(0, 15)) {
      parts.push(`- ${m.file}:${m.line} (${m.mutatorName}) — ${m.description}`);
    }
    parts.push("");
  }

  if (validation.staticAnalysisResult.issues.length > 0) {
    parts.push("## Lint issues");
    for (const issue of validation.staticAnalysisResult.issues.slice(0, 15)) {
      parts.push(`- ${issue.file}:${issue.line} [${issue.severity}] ${issue.message}`);
    }
    parts.push("");
  }

  parts.push("## Current file contents");
  for (const [path, content] of fileContents) {
    parts.push(`### ${path}`);
    parts.push("```");
    parts.push(content);
    parts.push("```");
  }
  parts.push("");
  parts.push(
    "Respond with ONLY a JSON object of the shape " +
      '{"summary": string, "changes": [{"path": string, "content": string}]}. ' +
      "`path` must exactly match one of the file paths shown above. `content` must be the FULL new " +
      "file content (not a diff). Do not include markdown fences around the JSON.",
  );

  return parts.join("\n");
}

function extractJson(raw: string): RepairResponse {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenced ? fenced[1] : trimmed;
  return JSON.parse(jsonText) as RepairResponse;
}

/**
 * "Bob" — sends the failure report + relevant source to Gemini and applies
 * the returned patch inside the sandbox's working copy. Runs on the host
 * (needs network for the API call) — see README for why this step is
 * intentionally outside the network-isolated container.
 */
export async function runRepair(
  targetDir: string,
  validation: ValidationReport,
  config: SentinelConfig,
  iteration: number,
): Promise<RepairAttempt> {
  const timestamp = new Date().toISOString();

  const candidatePaths = new Set<string>();
  for (const m of validation.mutationResult.survivedMutants) candidatePaths.add(m.file);
  for (const issue of validation.staticAnalysisResult.issues) candidatePaths.add(issue.file);

  if (candidatePaths.size < 4) {
    const allFiles = await listSourceFiles(targetDir);
    for (const f of allFiles) {
      if (candidatePaths.size >= 8) break;
      if (!config.allowTestEdits && isTestFile(f, config.testDirs)) continue;
      candidatePaths.add(f);
    }
  }

  const fileContents = new Map<string, string>();
  for (const path of candidatePaths) {
    const content = await readFileSafe(join(targetDir, path));
    if (content !== null) fileContents.set(path, content);
  }

  const prompt = buildPrompt(validation, fileContents);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      iteration,
      timestamp,
      prompt,
      model: config.repairModel,
      filesChanged: [],
      fileDiffs: [],
      diff: "",
      rawResponse: "",
      applied: false,
      error: "GEMINI_API_KEY is not set; repair agent cannot call the LLM.",
    };
  }

  let rawResponse = "";
  try {
    rawResponse = await callGemini(config.repairModel, apiKey, prompt);
  } catch (err) {
    return {
      iteration,
      timestamp,
      prompt,
      model: config.repairModel,
      filesChanged: [],
      fileDiffs: [],
      diff: "",
      rawResponse: "",
      applied: false,
      error: `Gemini API call failed: ${(err as Error).message}`,
    };
  }

  let parsed: RepairResponse;
  try {
    parsed = extractJson(rawResponse);
  } catch (err) {
    return {
      iteration,
      timestamp,
      prompt,
      model: config.repairModel,
      filesChanged: [],
      fileDiffs: [],
      diff: "",
      rawResponse,
      applied: false,
      error: `Could not parse repair response as JSON: ${(err as Error).message}`,
    };
  }

  const filesChanged: string[] = [];
  const fileDiffs: { path: string; diff: string }[] = [];
  const rejected: string[] = [];

  for (const change of parsed.changes ?? []) {
    if (!fileContents.has(change.path)) {
      rejected.push(`${change.path} (not in the provided context — refusing to create new files)`);
      continue;
    }
    if (!config.allowTestEdits && isTestFile(change.path, config.testDirs)) {
      rejected.push(`${change.path} (editing test files is disabled — see SENTINEL_ALLOW_TEST_EDITS)`);
      continue;
    }

    const before = fileContents.get(change.path) ?? "";
    if (change.content === before) {
      // The model echoed this file back unchanged — not a real edit, and
      // reporting it as one just clutters the report/dashboard with
      // "files changed" that have nothing in their diff.
      continue;
    }

    const absolutePath = join(targetDir, change.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, change.content, "utf8");
    filesChanged.push(change.path);
    fileDiffs.push({ path: change.path, diff: createTwoFilesPatch(change.path, change.path, before, change.content) });
  }

  const rejectedNote = rejected.map((r) => `# rejected: ${r}`).join("\n");
  const diff = [rejectedNote, ...fileDiffs.map((f) => f.diff)].filter(Boolean).join("\n\n");

  return {
    iteration,
    timestamp,
    prompt,
    model: config.repairModel,
    summary: parsed.summary,
    filesChanged,
    fileDiffs,
    diff,
    rawResponse,
    applied: filesChanged.length > 0,
    error: filesChanged.length === 0 ? "No applicable changes were applied." : undefined,
  };
}
