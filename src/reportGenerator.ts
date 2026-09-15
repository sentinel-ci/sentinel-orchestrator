import type { IterationRecord, RunHistory, TestGenReport, ValidationReport } from "./types.js";

function fmt(n: number): string {
  return n.toFixed(1);
}

function renderValidation(v: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`**Trust score: ${fmt(v.score.trustScore)} / 100** (threshold: ${v.threshold})`);
  lines.push("");
  lines.push("| Signal | Score | Weighted contribution |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| Unit test pass rate | ${fmt(v.score.unitTestPassRate)} (${v.testResult.passed}/${v.testResult.total}) | ${fmt(v.score.weightedContributions.unitTests)} |`,
  );
  lines.push(
    `| Mutation score | ${v.mutationResult.skipped ? "skipped" : fmt(v.score.mutationScore)} (${v.mutationResult.killed}/${v.mutationResult.totalMutants} killed) | ${fmt(v.score.weightedContributions.mutation)} |`,
  );
  lines.push(
    `| Static analysis cleanliness | ${fmt(v.score.staticAnalysisCleanliness)} (${v.staticAnalysisResult.errors} errors, ${v.staticAnalysisResult.warnings} warnings) | ${fmt(v.score.weightedContributions.staticAnalysis)} |`,
  );
  lines.push("");

  if (v.testResult.failures.length > 0) {
    lines.push("<details><summary>Failing tests</summary>");
    lines.push("");
    for (const f of v.testResult.failures.slice(0, 20)) {
      lines.push(`- \`${f.name}\`: ${f.message.split("\n")[0]}`);
    }
    lines.push("</details>");
    lines.push("");
  }

  if (v.mutationResult.survivedMutants.length > 0) {
    lines.push(
      `<details><summary>Survived mutants (${v.mutationResult.survivedMutants.length}) — evidence of weak/tautological tests</summary>`,
    );
    lines.push("");
    for (const m of v.mutationResult.survivedMutants.slice(0, 30)) {
      lines.push(`- \`${m.file}:${m.line}\` (${m.mutatorName}) — ${m.description}`);
    }
    lines.push("</details>");
    lines.push("");
  }

  if (v.mutationResult.skipped && v.mutationResult.skipReason) {
    lines.push(`> Mutation testing skipped: ${v.mutationResult.skipReason}`);
    lines.push("");
  }

  if (v.staticAnalysisResult.issues.length > 0) {
    lines.push("<details><summary>Lint issues</summary>");
    lines.push("");
    for (const issue of v.staticAnalysisResult.issues.slice(0, 30)) {
      lines.push(`- \`${issue.file}:${issue.line}\` [${issue.severity}] ${issue.ruleId ?? ""} ${issue.message}`);
    }
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

function renderIteration(record: IterationRecord): string {
  const lines: string[] = [`### Iteration ${record.iteration}`, ""];
  lines.push(renderValidation(record.validation));

  if (record.repair) {
    lines.push(`**🤖 Bob (repair agent)** — model: \`${record.repair.model}\``);
    lines.push("");
    if (record.repair.summary) {
      lines.push(`> 💬 ${record.repair.summary}`);
      lines.push("");
    }
    if (record.repair.error) {
      lines.push(`Repair failed: ${record.repair.error}`);
    } else if (record.repair.fileDiffs.length === 0) {
      lines.push("No files were actually changed.");
    } else {
      for (const f of record.repair.fileDiffs) {
        lines.push(`<details><summary>\`${f.path}\`</summary>`);
        lines.push("");
        lines.push("```diff");
        lines.push(f.diff.slice(0, 4000));
        lines.push("```");
        lines.push("</details>");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderTestGen(testGen: TestGenReport): string {
  const lines: string[] = [
    `**🧪 Alice (test generation agent)** — model: \`${testGen.model}\`, ${testGen.generatedTests.length} file(s) generated for ${testGen.targetFiles.length} changed module(s)`,
    "",
  ];
  for (const t of testGen.generatedTests) {
    if (t.error) {
      lines.push(`- \`${t.sourceFile}\`: failed — ${t.error}`);
      continue;
    }
    lines.push(`<details><summary>\`${t.path}\` (covers \`${t.sourceFile}\`)</summary>`);
    lines.push("");
    lines.push("```javascript");
    lines.push(t.content.slice(0, 4000));
    lines.push("```");
    lines.push("</details>");
  }
  lines.push("");
  return lines.join("\n");
}

/** Renders the full iteration history as a PR-comment-ready markdown report. */
export function renderMarkdownReport(history: RunHistory): string {
  const latest = history.iterations[history.iterations.length - 1];
  const header =
    history.outcome === "passed"
      ? "## ✅ Sentinel CI — trust threshold cleared"
      : history.outcome === "blocked"
        ? "## ❌ Sentinel CI — blocked after exhausting repair budget"
        : "## ⏳ Sentinel CI — validation in progress";

  const lines: string[] = [header, ""];
  if (latest) {
    lines.push(
      `Final trust score: **${fmt(latest.validation.score.trustScore)} / ${latest.validation.threshold}** after ${history.iterations.length} iteration(s).`,
    );
    lines.push("");
  }

  if (history.testGen && history.testGen.generatedTests.length > 0) {
    lines.push(renderTestGen(history.testGen));
    lines.push("---");
    lines.push("");
  }

  for (const record of history.iterations) {
    lines.push(renderIteration(record));
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/** JSON artifact — the machine-readable counterpart, stored per-PR for the retry loop and human review. */
export function renderJsonArtifact(history: RunHistory): string {
  return JSON.stringify(history, null, 2);
}
