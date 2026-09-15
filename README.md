# sentinel-orchestrator

The validation + repair engine for [Sentinel CI](https://github.com/sentinel-ci). Takes a
target app, has **Alice** write real tests for whatever a PR actually changed, runs the whole
thing through a sandboxed test → lint → mutation-testing pass scoped to those same changed
files, turns the result into a single 0-100 trust score, and — if the score misses the
threshold — has **Bob** repair the code and tries again, up to a bounded number of iterations.

This repo is the reusable engine. It doesn't contain a target app itself; it validates
whatever app is checked out alongside it in CI. Two target apps exercise it:

- [`sentinel-ci/sandbox-test`](https://github.com/sentinel-ci/sandbox-test) — a small
  Express + Mongo items API, the original repo this project was built against.
- [`sentinel-ci/demo-crud-app`](https://github.com/sentinel-ci/demo-crud-app) — a purpose-built
  demo app (JWT auth + per-user CRUD, in-memory store, **zero hand-written tests** — every
  test that exists for it is Alice's) with a real PR that plants a genuine auth bug and walks
  through the full catch → repair → pass cycle. This is the one to look at first; see
  "Verified end-to-end" below.

## Verified end-to-end (not just written — actually run, repeatedly, until it worked)

Everything below was confirmed with a real run, not inferred from reading the code:

- **Mutation testing catches tautological tests.** A deliberately fake test
  (`expect(true).toBe(true)` after calling the function under test) scored 0% mutation
  killed (17 survived / 0 killed) against a real module — the exact failure mode this whole
  project exists to catch.
- **Bob genuinely fixes bugs, not just makes scores go up.** Given a real off-by-one bug
  (sort order flipped) with only the failing test as input, Bob produced a minimal, correct,
  one-line patch with no unrelated changes.
- **A real gate bug, found and fixed via an actual run**: StrykerJS refuses to run mutation
  testing at all when the baseline has a failing test (sensible on Stryker's part), which
  means mutation testing is skipped on *every* PR with a failing test — and the weight
  redistribution meant for a *skipped* signal made the blended score lenient enough (96.3/100
  against a 75 threshold) that a PR with a real, deliberately-introduced regression would
  have been promoted. Fixed: `decide()` now hard-blocks "pass" whenever any test is literally
  failing, independent of blended score.
- **Alice's tests are not just present, they're meaningful.** Scoped mutation testing against
  a module covered only by an Alice-generated test file: 100% killed (0 survived).
- **The live dashboard streams real events from inside a real `--network=none` container**,
  through the host, to a real browser, confirmed via screenshot at each stage of a live run.
- **A full demo PR run, for real, through actual GitHub Actions**, not a local simulation:
  Alice generates tests for a genuinely broken `login()` → her test fails against it → Bob
  reads the failure and produces the correct one-line fix (`===` back to `!==`) with a clear
  plain-English summary → re-validation passes at 95.6/100 with a real 89% mutation score.
  See `sentinel-ci/demo-crud-app` PR #1.
- **Three more bugs found specifically *because* that last run was watched end-to-end instead
  of assumed correct** — see "Open Design Decisions" below for what they were and how they
  were fixed: a wrong import path Alice guessed for a secondary file, a test-suite crash that
  was completely invisible to the trust score, and — the most important one — Alice asserting
  a bug's behavior as if it were correct because she had no notion of *intended* behavior.

## Architecture

```
                         ┌─────────────────────────────────────────┐
 GitHub Actions runner   │  orchestrate.ts (host, has network)      │
 (target app's           │  - resolves PR number, lists changed     │
  sentinel.yml)          │    files via the GitHub API               │
                         │  - creates a sentinel-dashboard run,     │
                         │    posts "watch live" PR comment (also   │
                         │    written to the Actions job summary)   │
                         │  - runs the retry loop                   │
                         │  - updates PR comment with final report  │
                         │  - opens promotion PR / adds block label  │
                         └───────────────┬───────────────────────────┘
                                          │
                          once, before the first iteration:
                          🧪 Alice (aliceAgent.ts) writes a new Jest
                          test file for each changed production file
                                          │
                                          │ docker build && docker run
                                          │   --network=none --memory=512m --cpus=1
                                          │   (host tails container stdout live)
                                          ▼
                         ┌─────────────────────────────────────────┐
 sandbox container       │  validate.ts (in-container, no network)  │
                         │  - testRunner.ts    (Jest — incl. Alice's) │
                         │  - staticAnalysis.ts (ESLint)             │
                         │  - mutationRunner.ts (StrykerJS, scoped   │
                         │    to the PR's changed files)             │
                         │  - aggregator.ts    (trust score)         │
                         │  writes SENTINEL_EVENT: marker lines to   │
                         │  stdout at each phase boundary            │
                         └───────────────┬─────────────────────────┘
                                          │ trust score below threshold
                                          │ (or any test literally failing)
                                          ▼
                          🤖 Bob (repairAgent.ts, host, has network)
                          patches the working copy — production code
                          only, never touches Alice's test files —
                          loop rebuilds and re-validates from scratch
```

Each retry iteration rebuilds the sandbox image (Docker layer caching keeps this cheap —
`npm ci` and the tooling-install layers don't change between iterations, only the final
`COPY` layers do) and reruns `validate.ts` inside it. Bob applies his patch to the checked-out
working copy between iterations, then the loop triggers the next build. Alice, unlike Bob,
runs exactly once per run (not once per iteration) — her generated tests just become part of
the test suite every iteration re-runs, same as any pre-existing test.

### Alice and Bob are structurally independent — not just by convention

This matters enough to spell out precisely, since it's the thing that keeps both of them
honest:

- **Alice runs once, before iteration 0, and never again.** She has no visibility into
  anything Bob does afterward — she's not "aware" of the repair loop at all.
- **Bob cannot write to test files.** In `repairAgent.ts`, any proposed change whose path is
  under a configured test directory gets rejected before it ever reaches disk, unless
  `SENTINEL_ALLOW_TEST_EDITS=true` (default `false`). Even if Bob's model output includes a
  test-file "fix," it's discarded.
- **Every iteration re-validates from a fresh container build.** Bob doesn't get to declare
  victory — the next iteration reruns Alice's tests (and everyone else's) independently, same
  as the first.

The result: Alice writes the tests once and is done; Bob never sees her, can't edit her work,
and can't negotiate with her. She's a fixed, independent judge every iteration is re-run
against — which is exactly what makes a passing score mean something.

### Alice and Bob share one Gemini client (`gemini.ts`)

Both agents call the same `callGemini`/`callGeminiForText` helpers — the only difference is
Bob asks for structured JSON (a list of file patches + a plain-English `summary` of what he
did and why) and Alice asks for raw source code in a fenced block. Neither agent's code lives
inside the sandbox; both need network to reach Gemini, so both run on the host, same reasoning
as "why the repair agent runs on the host" below.

### Why mutation testing (and Alice) are scoped to the PR's changed files, not the whole repo

Two independent reasons converged on the same answer:

1. **Cost.** Re-mutating the entire codebase on every PR doesn't scale, and arguably isn't
   even the right question — a PR should be judged on whether *its* changes are well-tested,
   not re-graded on unrelated legacy code's mutation score every time.
2. **It fixes the mongo-per-mutant slowness documented below, organically.** When mutation
   testing is scoped to a file that only Alice's new test file exercises, Stryker's per-test
   coverage analysis runs *only that test file* per mutant — not the full suite. Verified
   directly: mutating a small new module with Alice's generated tests took **36 seconds for
   35 mutants** (100% killed), versus the ~30s/mutant, ~10-minute-budget-exhausting behavior
   measured earlier against the full suite. Scoping to changed files doesn't fix the
   underlying per-suite-run cost for a large *existing* file with lots of correlated test
   coverage, but for the common case of new/changed logic with its own new test, it mostly
   resolves itself.

`SENTINEL_CHANGED_FILES` (comma-separated, set by `orchestrate.ts` from the GitHub PR-files
API via `githubClient.ts`'s `listChangedFiles`) carries this scope from the host into the
sandboxed `validate.ts` via `docker run -e`, since the container has no network to look it up
itself. Non-JS files and files already under a configured test directory are filtered out
before Alice or Stryker ever see the list.

### Live dashboard reporting (optional)

If `SENTINEL_DASHBOARD_URL` is set, `retryLoop.ts` creates a run on a
[sentinel-dashboard](https://github.com/sentinel-ci/sentinel-dashboard) deployment before
the first iteration and `orchestrate.ts` immediately posts a PR comment linking to it (and
writes the same link to the GitHub Actions job summary, via `$GITHUB_STEP_SUMMARY`, so it's
visible on the Actions run page too) — so a human can watch the run happen instead of only
seeing raw GitHub Actions logs, and only finding out the outcome once everything is already
done.

The sandbox container is `--network=none` and genuinely cannot call the dashboard itself.
Instead, `validate.ts` writes `SENTINEL_EVENT:{"phase":...,"kind":"start"|"end","data":...}`
marker lines to its own stdout at each phase boundary; `sandbox.ts`'s `runValidationInSandbox`
streams the container's stdout live (not just captured-and-parsed-at-exit) and `retryLoop.ts`
relays each marker to the dashboard via `telemetry.ts` as it arrives. So progress is live at
the *phase* granularity (build/test-generation/tests/lint/mutation/score/repair, each
iteration) — not literally line-by-line inside the sandboxed run, since that would mean
giving untrusted PR code a way to phone out, which is exactly what `--network=none` exists
to prevent.

Every `telemetry.ts` call is best-effort and swallows its own errors: a dashboard being
down, misconfigured, or simply not set up must never fail the actual validation/repair
pipeline. Omit `SENTINEL_DASHBOARD_URL` entirely to skip this whole path — the PR comment
with the final markdown report still gets posted either way.

### Module map

| File | Responsibility |
| --- | --- |
| `src/testRunner.ts` | Runs the target's Jest suite, returns `{ passed, failed, total, failures }` — including synthesizing a failure for a test suite that crashed before any test ran (see "Open Design Decisions") |
| `src/staticAnalysis.ts` | Runs ESLint (target's own config, or the bundled fallback), returns `{ errors, warnings, issues }` |
| `src/mutationRunner.ts` | Runs StrykerJS, optionally scoped to a file list via `--mutate`, returns `{ mutationScore, killed, survived, survivedMutants }` — the key "are these tests actually meaningful" signal |
| `src/aggregator.ts` | Combines the three signals into a weighted 0-100 trust score |
| `src/reportGenerator.ts` | Renders the markdown (PR comment) and JSON (artifact) reports, including Alice's generated tests and Bob's per-file diffs + summary |
| `src/decisionGate.ts` | Pure `(trustScore, threshold, iteration, maxIterations, hasFailingTests) -> pass \| repair \| block` |
| `src/aliceAgent.ts` | "Alice" — generates a new Jest test file per changed production file; includes a regex-based safety net that fixes broken relative `require()` paths before the file is ever written |
| `src/repairAgent.ts` | "Bob" — sends the failure report to Gemini, applies the returned patch (production files only), filters out no-op "changes," captures the model's own summary |
| `src/gemini.ts` | Shared Gemini REST client used by both Alice and Bob (no SDK dependency) |
| `src/retryLoop.ts` | Bounded validate → repair → re-validate loop; runs Alice once up front, then loops build → validate → (repair if needed) |
| `src/sandbox.ts` | `docker build`/`docker run` wrapper (BuildKit named contexts); streams container stdout live for dashboard relay |
| `src/exec.ts` | `runCommand` — the underlying spawn wrapper; kills the whole process *group* on timeout, not just the direct child (matters for `npx`-wrapped tools that spawn workers) |
| `src/sourceFiles.ts` | Repo-tree helpers: listing source files, reading a file with a size cap, detecting whether a path is a test file |
| `src/githubClient.ts` | PR comments (post/update), labels, listing a PR's changed files, opening the staging→production promotion PR |
| `src/validate.ts` | In-container entrypoint (test + lint + mutation + score, one pass); reads `SENTINEL_CHANGED_FILES` to scope mutation testing |
| `src/orchestrate.ts` | Host entrypoint: resolves PR context, lists changed files, creates the dashboard run, runs the retry loop, posts PR comments and the job summary, opens the promotion PR or labels as blocked |
| `src/telemetry.ts` | Best-effort client for a sentinel-dashboard deployment; also the `SENTINEL_EVENT:` marker-line protocol between `validate.ts` and the host |
| `src/config.ts` | All thresholds/weights/budgets/model names, env-driven |
| `src/types.ts` | Shared types for every report/attempt/event shape |

## Why the repair agent runs on the host, not inside the sandbox

The sandbox is `--network=none` by design — the whole point is to execute
possibly-untrusted PR code without giving it network access. But the repair step needs
outbound HTTPS to call the Gemini API, which is a genuine contradiction with a literal
reading of "network=none, no new container spin-up mid-loop."

Resolution: **only code execution happens inside the isolated container.** The repair
agent runs on the GitHub Actions runner, reads the validation report (data, not code
execution), calls Gemini, and writes the patch directly to the checked-out working
copy on the host. The container is rebuilt for the next iteration from that updated
working copy. This keeps the actual untrusted-code-execution boundary intact
(nothing the PR's code does ever runs with network access) while still letting the
repair step reach the LLM. It also means Stryker/ESLint tooling never needs allowlisted
domains or a partial network policy — the container stays fully offline.

The tradeoff against the plan's literal "keep the isolation boundary at the PR level,
not the iteration level, no new container spin-up mid-loop": each iteration *does*
spin up a fresh container. In practice this is cheap (Docker build cache), and the
alternative — keeping one container alive across iterations — would require either
giving it network (defeating the isolation) or bind-mounting node_modules in a way
that reintroduces the same build/runtime dependency-install split this design already
solves cleanly. Documented here rather than silently deviating from the plan.

## Open Design Decisions (resolved defaults — reconsider before relying on them)

Every item here that describes a "found via a real run" bug was found by actually executing
the pipeline against real code — including three in a row, back to back, found only because
a demo run was watched all the way through instead of stopping at "the code looks right."

### Alice

- **Alice's own import path is computed by our code and handed to her, not guessed — and
  it's still backed by a runtime safety net, because prompt instructions alone weren't
  reliable enough.** First version let Alice guess the relative `require()` path from her
  own test file back to the module under test. She got it wrong (off by one directory level
  — she has no way to know where her own output file will land ahead of generating it), and
  every generated test failed with "Cannot find module." Fixed by computing the exact path
  in `aliceAgent.ts` (`computeRequireSpecifier`) and stating it explicitly in the prompt.
  That fix wasn't enough on its own: a later real run had her get a *second*, unrelated
  import (a shared in-memory store, not the module under test) wrong the same way, because
  the prompt only ever told her the path for the primary module. Since Bob is deliberately
  barred from editing test files, **nothing downstream can ever fix a broken import in
  Alice's own test** — confirmed for real: a demo run sat at an unchanged, misleadingly
  "clean" score for its entire 3-iteration repair budget because of exactly this. Fixed
  twice over: the prompt now states a general rule (apply the same relative depth to *any*
  other file you need to import), and `aliceAgent.ts` runs a regex-based `fixRequirePaths`
  pass after generation that resolves any relative `require()` that doesn't actually exist
  against the real repo tree and rewrites it, before the file is ever written to disk.
- **Alice must assert intended behavior, not observed behavior.** The most important finding
  of the whole project, found via the same real demo run: given a genuinely broken `login()`
  (comparison operator flipped — correct passwords rejected, wrong ones accepted), Alice's
  first attempt *noticed* the bug in her own reasoning (a code comment she wrote read "a
  matching hash actually triggers the 401 response (an intentional or buggy quirk)") and then
  asserted the buggy behavior anyway, with a comment like "following current implementation
  logic." The suite passed. The bug shipped. Nothing downstream ever saw a problem. A test
  suite generated purely from source, with no notion of what the code is *supposed* to do,
  will happily encode its bugs as spec — this silently defeats the entire point of the
  project for exactly the bugs that matter most. Fixed by telling Alice explicitly to infer
  intent from names/comments/conventions and assert *that*, not to rationalize an observed
  mismatch as deliberate. Re-run after the fix: Alice's test failed against the same bug,
  Bob fixed it correctly, and the PR passed for real. Not a complete fix — an LLM can still
  misjudge intent — but it changes the default from "describe what you see" to "assert what
  should be true," which is the only sane default for this job.
- **Alice never edits existing tests, only adds new files** — she has no path to "fix" a low
  score by weakening coverage, same reasoning as Bob's test-edit restriction.
- **Alice's test-gen scope and mutation-testing's scope are the same list** (the PR's changed
  production files) rather than two independently-tuned scopes, for consistency: whatever
  the PR touched is both what gets a fresh test and what gets mutated.
- **Alice runs `maxTestGenFiles` (default 8) at most per run** — a blunt cost cap for PRs
  that touch a lot of files at once. No prioritization logic beyond "first N in the changed
  file list" yet.

### Bob

- **Bob's report used to list files as "changed" even when nothing was actually different**
  — found from direct user feedback on a live demo run, not code review. His JSON response
  sometimes echoes a file back with identical content (no real edit), and the old code
  counted every entry in `changes` as a real change regardless. `repairAgent.ts` now compares
  before/after content and silently drops true no-ops from `filesChanged`/`fileDiffs` — they
  were never real changes, so they shouldn't clutter the report as if they were.
  Same feedback also pointed out that Bob's own stated reasoning (the `summary` field his
  JSON response always included) was being parsed and then discarded. It's now captured and
  surfaced verbatim, as a quoted explanation, in both the markdown report and the dashboard.
- **Repair agent scope: production code only by default.** `SENTINEL_ALLOW_TEST_EDITS` must
  be explicitly set to `"true"` to let Bob touch files under a configured test directory or
  matching `*.test.*`/`*.spec.*`. Letting him edit tests by default would let him "fix" a low
  trust score by weakening the very tests mutation testing (and Alice) exist to validate —
  exactly the failure mode this project exists to prevent.

### The pipeline itself

- **A test suite that crashes before any test runs used to be completely invisible to the
  trust score, the gate, and Bob alike.** Jest's aggregated JSON gives a suite that fails to
  even load (a require error, a syntax error) zero contribution to `numTotalTests` and an
  empty `assertionResults` array — the only place the failure shows up is a `message` field
  on that file's result object, which `testRunner.ts` didn't read. Found via the same demo
  run as the Alice import-path bug above: the report showed a deceptively clean "0/0 tests"
  for three repair iterations in a row, no indication anything was wrong, no way for Bob to
  know what to fix even if he'd been allowed to. Fixed: a crashed suite now counts as one
  failure, with Jest's own suite-level error message attached, so it's visible everywhere
  downstream — the score, the gate's `hasFailingTests` check, and (for cases where Bob *is*
  the one who broke something) his own next prompt.
- **A test suite with any literally failing test can never "pass," independent of blended
  score.** Found via a real run: StrykerJS refuses to run mutation testing at all when the
  baseline has a failing test (sensible on Stryker's part — a broken baseline makes mutant
  survival meaningless), which means mutation testing is skipped on *every* PR with a failing
  test. That skip redistributes mutation's weight onto unit-test-pass-rate + static analysis,
  and the blended score came out to 96.3/100 against a 75 threshold on a real run with a
  genuine, deliberately-introduced regression — the gate would have promoted it. `decide()`
  now takes `hasFailingTests` and hard-blocks "pass" when true, no matter the score.
- **Trust score formula**: `0.4 * unitTestPassRate + 0.4 * mutationScore + 0.2 * staticAnalysisCleanliness`.
  Unit tests and mutation score are weighted equally on the theory that a passing-but-weak
  suite (high pass rate, low mutation score) should score no better than a suite that's
  visibly failing — mutation testing exists specifically to catch that case. Static
  analysis is a smaller weight because lint issues are usually lower-severity than either
  correctness signal. **Not empirically validated** — tune via `SENTINEL_WEIGHT_*` env vars.
- **Promotion threshold**: `75/100` by default (`SENTINEL_PROMOTION_THRESHOLD`). Picked as
  a round number that fails a suite with either significant lint noise or a mutation score
  below ~60%, without requiring perfection. Needs empirical tuning against real PRs.
- **Retry budget**: `3` iterations (`SENTINEL_MAX_ITERATIONS`). Each iteration is a full
  Docker rebuild + test + lint + mutation run + one LLM call, so this is a real CI-time/cost
  tradeoff, not just a correctness one.
- **Mutation testing unavailable → score, don't fail closed**: if Stryker can't run (missing
  tooling, config crash, or the bounded time budget below expiring), its weight is
  redistributed across the other two signals rather than counted as 0. A sandbox/tooling
  problem isn't evidence the PR's tests are bad. (This is exactly the mechanism the
  hasFailingTests fix above had to be layered on top of — redistribution is right for a
  genuine tooling gap, wrong as the *only* safeguard against a failing test being masked.)
- **Test runner**: hardcoded to Jest for v1 (matches both target apps). Swapping to Vitest or
  another runner means adding a sibling to `testRunner.ts` and selecting it based on the
  target's `package.json`.
- **Sentinel's own lint/mutation tooling is installed as ephemeral devDependencies of the
  target app** at Docker build time (`npm install --no-save eslint @stryker-mutator/core
  @stryker-mutator/jest-runner` inside `/app`), rather than kept in its own isolated
  `node_modules`. This sidesteps Stryker's jest-runner needing to resolve the target's own
  Jest config/binary from a sibling package — simpler, at the cost of transiently polluting
  the target's installed packages inside the (ephemeral, per-build) sandbox image only.
  Nothing is written back to the target app's own `package.json`/lockfile.
- **Native-binary prefetch (e.g. `mongodb-memory-server`)**: the Dockerfile runs
  `scripts/prefetch-mongo.js` at build time *if the target app provides one* — a narrow,
  demo-app-specific convention rather than a general pre-test-setup hook (and one that
  `demo-crud-app` deliberately avoids needing at all, by using an in-memory store instead of
  a real database). A real v2 would generalize this to something like `sentinel.setup.js`.
- **Mutation testing has a bounded time budget (10 min by default), not an unbounded run**:
  for `sandbox-test`, full unscoped mutation testing (168 mutants across app.js/config/
  models/routes/server.js) takes on the order of an hour under `--cpus=1`, because its test
  setup spins up a real (in-memory) MongoDB process fresh for every mutant — that cost is
  paid ~168 times, not once. Rather than block the pipeline on that, `mutationRunner.ts`
  gives Stryker a fixed time budget and treats a still-running Stryker process as
  "unavailable" (see the redistribute-weight decision above), same as a crash. Diff-scoping
  (see above) mostly resolves this for new/changed logic with its own new test, but a large
  *existing* file with lots of correlated coverage would still pay the same per-suite-run
  cost. **This also means the retry loop's real-world iteration time is dominated by
  mutation testing, not by the LLM call** — budget CI time accordingly.
- **`sentinel-orchestrator` is a public repo**, unlike either target app. It needs to be
  checked out by any target app's CI workflow via `actions/checkout`, and GitHub's per-repo
  "Access" setting for private repos does not extend to that — it only covers reusable
  workflow *references*, not a general `actions/checkout` of another repo's contents. The
  alternative (a PAT stored as a secret on every target app) works too, but public was
  simpler and there's no proprietary logic in this repo worth keeping private.

## Configuration

All of the above are env vars, read in `src/config.ts`:

| Env var | Default |
| --- | --- |
| `SENTINEL_WEIGHT_UNIT_TESTS` | `0.4` |
| `SENTINEL_WEIGHT_MUTATION` | `0.4` |
| `SENTINEL_WEIGHT_STATIC_ANALYSIS` | `0.2` |
| `SENTINEL_PROMOTION_THRESHOLD` | `75` |
| `SENTINEL_MAX_ITERATIONS` | `3` |
| `SENTINEL_ALLOW_TEST_EDITS` | `false` |
| `SENTINEL_REPAIR_MODEL` | `gemini-3.5-flash-lite` (Bob) |
| `SENTINEL_TEST_GEN_MODEL` | `gemini-3.5-flash-lite` (Alice) |
| `SENTINEL_ENABLE_TEST_GENERATION` | `true` — set `"false"` to disable Alice entirely |
| `SENTINEL_MAX_TEST_GEN_FILES` | `8` — cap on changed files Alice generates tests for per run |
| `SENTINEL_TEST_DIRS` | `tests,test,__tests__` |
| `SENTINEL_PR_NUMBER` | (read from `GITHUB_EVENT_PATH` if unset) |
| `SENTINEL_CHECKOUT_DIR` | `process.cwd()` — the target app's checked-out path |
| `SENTINEL_ORCHESTRATOR_DIR` | `process.cwd()` — this repo's checked-out path |
| `SENTINEL_PRODUCTION_BRANCH` / `SENTINEL_STAGING_BRANCH` | `production` / `staging` |
| `SENTINEL_DASHBOARD_URL` | unset (dashboard reporting skipped entirely) |
| `SENTINEL_DASHBOARD_TOKEN` | must match the dashboard's `DASHBOARD_INGEST_TOKEN` |
| `GEMINI_API_KEY` | required for Alice and Bob to run at all |
| `GITHUB_TOKEN` | required to post PR comments, list changed files, open the promotion PR |
| `GITHUB_EVENT_PATH` | set automatically by GitHub Actions; used to resolve the PR number/title/URL |
| `GITHUB_STEP_SUMMARY` | set automatically by GitHub Actions; if present, the live dashboard link is also written there |

## Local development

```bash
npm install
npm run typecheck
npm test           # unit tests for the pure modules (aggregator, decisionGate, reportGenerator)
npm run build
```

`testRunner.ts` / `staticAnalysis.ts` / `mutationRunner.ts` / `aliceAgent.ts` / `repairAgent.ts`
shell out to the target app's own tooling or call a real LLM, so they're best exercised
against a real target app directory rather than unit-tested in isolation. That's how every
bug listed under "Open Design Decisions" above was actually found — by running the real
pipeline against real target apps (`sandbox-test`, `demo-crud-app`, and disposable scratch
copies of both) until something broke, not by reasoning about the code in the abstract.

## Running the full sandbox locally

```bash
docker build -f sandbox/Dockerfile \
  --build-context target=/path/to/target-app \
  --build-context sentinel=. \
  -t sentinel-sandbox .

docker run --rm --init --memory=512m --cpus=1 --network=none sentinel-sandbox
```

(`--init` matters: without a minimal PID-1 init process, orphaned children — the mongod
instances StrykerJS's test runner spins up per mutant, in particular — accumulate as zombies
for the container's whole lifetime.)
