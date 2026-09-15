import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { SentinelConfig } from "./config.js";
import { callGeminiForText, extractFencedCode } from "./gemini.js";
import { isTestFile, listSourceFiles, readFileSafe } from "./sourceFiles.js";
import type { GeneratedTest, TestGenReport } from "./types.js";

function generatedTestPath(testDir: string, sourceFile: string): string {
  const flat = sourceFile.replace(/[\\/]/g, "__").replace(/\.js$/, "");
  return join(testDir, "alice-generated", `${flat}.alice.test.js`);
}

/** Relative-import specifier from the generated test's own location to some repo-relative target path, e.g. "../../utils/discount". Computed here (not guessed by the model) since Alice has no way to know her own output path ahead of time. */
function computeRequireSpecifier(targetDir: string, testPath: string, destFile: string): string {
  const raw = relative(dirname(join(targetDir, testPath)), join(targetDir, destFile)).replace(/\.js$/, "");
  const posix = raw.split(sep).join("/");
  return posix.startsWith(".") ? posix : `./${posix}`;
}

/**
 * Regex-scans generated code for relative `require(...)` calls that don't
 * actually resolve, and fixes them by finding a same-named file elsewhere in
 * the repo — a safety net behind the prompt instructions, not a replacement
 * for them. Necessary because Bob (the repair agent) is deliberately barred
 * from editing test files, so if Alice's own import path is wrong, nothing
 * downstream can ever fix it — confirmed for real: a demo run got stuck at
 * an unchanged 0/0-tests score for its entire repair budget because Alice's
 * test crashed on a bad `require('../store')` (should've been `../../store`)
 * and Bob had no path to touch it.
 */
async function fixRequirePaths(code: string, testAbsolutePath: string, targetDir: string): Promise<string> {
  const pattern = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;
  const testDir = dirname(testAbsolutePath);
  let fixed = code;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const [full, quote, importPath] = match;
    const resolved = await resolvesToFile(join(testDir, importPath));
    if (resolved) continue;

    const wanted = basename(importPath).replace(/\.js$/, "");
    const candidates = (await listSourceFiles(targetDir)).filter(
      (f) => !f.includes("alice-generated") && basename(f).replace(/\.js$/, "") === wanted,
    );
    if (candidates.length !== 1) continue; // ambiguous or no match — leave it, testRunner will surface the real error

    const correctSpecifier = computeRequireSpecifier(targetDir, relative(targetDir, testAbsolutePath), candidates[0]);
    fixed = fixed.replace(full, `require(${quote}${correctSpecifier}${quote})`);
  }

  return fixed;
}

async function resolvesToFile(pathWithoutKnownExtension: string): Promise<boolean> {
  for (const candidate of [pathWithoutKnownExtension, `${pathWithoutKnownExtension}.js`, join(pathWithoutKnownExtension, "index.js")]) {
    try {
      await access(candidate);
      return true;
    } catch {
      // keep trying
    }
  }
  return false;
}

function buildPrompt(sourceFile: string, sourceContent: string, exampleTest: string | null, requireSpecifier: string): string {
  const parts: string[] = [];
  parts.push(
    "You are Alice, a test-writing agent in an automated CI pipeline (Sentinel CI). " +
      "Your job is to write a NEW, genuinely useful Jest test file for the module below — " +
      "one that exercises real logic and would actually fail if that logic broke.",
  );
  parts.push("");
  parts.push(`## Module to test: ${sourceFile}`);
  parts.push(
    `Import it with exactly this path (this accounts for where your test file will actually be saved — ` +
      `do not guess a different relative path): \`require("${requireSpecifier}")\`. If you need to import ` +
      "ANY other file from this repo (a shared store, a helper, etc.), apply the same relative depth — " +
      `e.g. a file at the repo root needs the same number of \`../\` segments as shown above.`,
  );
  parts.push("```javascript");
  parts.push(sourceContent);
  parts.push("```");

  if (exampleTest) {
    parts.push("");
    parts.push(
      "## Existing test file in this repo, for style/convention reference only " +
        "(module system, assertion library, any shared test setup already configured elsewhere — do not repeat that setup, it runs automatically)",
    );
    parts.push("```javascript");
    parts.push(exampleTest);
    parts.push("```");
  }

  parts.push("");
  parts.push("## Requirements");
  parts.push("- Cover real behavior: valid inputs, edge cases, error/validation paths, boundary conditions.");
  parts.push(
    "- Every test must make a meaningful assertion about the module's actual output or behavior. " +
      'Never write a test that would pass regardless of the code under test (e.g. `expect(true).toBe(true)`, ' +
      "calling a function without checking what it returns/throws, or asserting on a mock instead of real behavior).",
  );
  parts.push(
    "- Assert the INTENDED behavior, not merely whatever the code currently happens to do. Infer intent from " +
      "function/variable names, comments, error messages, and conventional behavior for this kind of code " +
      "(e.g. a function called `login` that checks a password hash should reject a WRONG password and accept " +
      "a CORRECT one — that's the intent, regardless of what the code currently does). If you notice the " +
      "implementation looks like it might contradict its own apparent intent, do not rationalize it as " +
      "deliberate or rewrite your assertion to match what you observed — write the test for the correct, " +
      "intended behavior anyway. A test that fails against buggy code is doing its job; a test quietly rewritten " +
      "to match a bug is not.",
  );
  parts.push("- Match the existing codebase's module system (require/module.exports, not import/export) unless the module itself uses ES modules.");
  parts.push("- Do not modify or re-declare any global test setup; assume it's already in effect.");
  parts.push("- Respond with ONLY the test file's source code in a single fenced code block. No explanation.");

  return parts.join("\n");
}

/**
 * "Alice" — generates a new Jest test file for each of a PR's changed
 * production files. Runs on the host (network required for the Gemini
 * call), once per run, before the first validation pass — see retryLoop.ts.
 */
export async function runTestGeneration(
  targetDir: string,
  changedProductionFiles: string[],
  config: SentinelConfig,
): Promise<TestGenReport> {
  const timestamp = new Date().toISOString();
  const targetFiles = changedProductionFiles.slice(0, config.maxTestGenFiles);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { timestamp, model: config.testGenModel, targetFiles, generatedTests: [] };
  }

  const exampleTest = await findExampleTest(targetDir, config.testDirs);
  const primaryTestDir = config.testDirs[0] ?? "tests";
  const generatedTests: GeneratedTest[] = [];

  for (const sourceFile of targetFiles) {
    const sourceContent = await readFileSafe(join(targetDir, sourceFile), 8000);
    if (sourceContent === null) {
      generatedTests.push({ path: "", sourceFile, content: "", error: "Could not read source file." });
      continue;
    }

    const relativeTestPath = generatedTestPath(primaryTestDir, sourceFile);
    const requireSpecifier = computeRequireSpecifier(targetDir, relativeTestPath, sourceFile);
    const prompt = buildPrompt(sourceFile, sourceContent, exampleTest, requireSpecifier);

    try {
      const raw = await callGeminiForText(config.testGenModel, apiKey, prompt);
      const generated = extractFencedCode(raw);
      const absolutePath = join(targetDir, relativeTestPath);
      const code = await fixRequirePaths(generated, absolutePath, targetDir);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, code, "utf8");
      generatedTests.push({ path: relativeTestPath, sourceFile, content: code });
    } catch (err) {
      generatedTests.push({
        path: relativeTestPath,
        sourceFile,
        content: "",
        error: `Gemini call failed: ${(err as Error).message}`,
      });
    }
  }

  return { timestamp, model: config.testGenModel, targetFiles, generatedTests };
}

async function findExampleTest(targetDir: string, testDirs: string[]): Promise<string | null> {
  const files = await listSourceFiles(targetDir);
  const testFile = files.find((f) => isTestFile(f, testDirs));
  if (!testFile) return null;
  return readFileSafe(join(targetDir, testFile), 4000);
}
