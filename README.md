# sentinel-orchestrator

The validation + repair engine for [Sentinel CI](https://github.com/sentinel-ci). Takes a
target app, runs it through a sandboxed test → lint → mutation-testing pass, turns the
result into a single 0-100 trust score, and — if the score misses the threshold — asks
Gemini to repair the code and tries again, up to a bounded number of iterations.

This repo is the reusable engine. It doesn't contain a target app itself; it validates
whatever app is checked out alongside it in CI (see `sentinel-ci/sandbox-test` for the
current demo app and the workflow that wires the two together).

## Architecture

```
                         ┌─────────────────────────────────────────┐
 GitHub Actions runner   │  orchestrate.ts (host, has network)      │
 (sandbox-test's         │  - resolves PR number                    │
  sentinel.yml)          │  - creates a sentinel-dashboard run,     │
                         │    posts "watch live" PR comment         │
                         │  - runs the retry loop                   │
                         │  - updates PR comment with final report  │
                         │  - opens promotion PR / adds block label  │
                         │  - calls Gemini (repairAgent.ts)          │
                         └───────────────┬───────────────────────────┘
                                          │ docker build && docker run
                                          │   --network=none --memory=512m --cpus=1
                                          │   (host tails container stdout live)
                                          ▼
                         ┌─────────────────────────────────────────┐
 sandbox container       │  validate.ts (in-container, no network)  │
                         │  - testRunner.ts    (Jest)                │
                         │  - staticAnalysis.ts (ESLint)             │
                         │  - mutationRunner.ts (StrykerJS)          │
                         │  - aggregator.ts    (trust score)         │
                         │  writes SENTINEL_EVENT: marker lines to   │
                         │  stdout at each phase boundary            │
                         └─────────────────────────────────────────┘
```

Each retry iteration rebuilds the sandbox image (Docker layer caching keeps this cheap —
`npm ci` and the tooling-install layers don't change between iterations, only the final
`COPY` layers do) and reruns `validate.ts` inside it. `orchestrate.ts` on the host applies
the repair patch to the checked-out working copy between iterations, then triggers the
next build.

### Live dashboard reporting (optional)

If `SENTINEL_DASHBOARD_URL` is set, `retryLoop.ts` creates a run on a
[sentinel-dashboard](https://github.com/sentinel-ci/sentinel-dashboard) deployment before
the first iteration and `orchestrate.ts` immediately posts a PR comment linking to it — so
a human can watch the run happen instead of only seeing raw GitHub Actions logs, and only
finding out the outcome once everything is already done.

The sandbox container is `--network=none` and genuinely cannot call the dashboard itself.
Instead, `validate.ts` writes `SENTINEL_EVENT:{"phase":...,"kind":"start"|"end","data":...}`
marker lines to its own stdout at each phase boundary; `sandbox.ts`'s `runValidationInSandbox`
streams the container's stdout live (not just captured-and-parsed-at-exit) and `retryLoop.ts`
relays each marker to the dashboard via `telemetry.ts` as it arrives. So progress is live at
the *phase* granularity (build/tests/lint/mutation/score/repair, each iteration) — not
literally line-by-line inside the sandboxed run, since that would mean giving untrusted PR
code a way to phone out, which is exactly what `--network=none` exists to prevent.

Every `telemetry.ts` call is best-effort and swallows its own errors: a dashboard being
down, misconfigured, or simply not set up must never fail the actual validation/repair
pipeline. Omit `SENTINEL_DASHBOARD_URL` entirely to skip this whole path — the PR comment
with the final markdown report still gets posted either way.

### Module map

| File | Responsibility |
| --- | --- |
| `src/testRunner.ts` | Runs the target's Jest suite, returns `{ passed, failed, total, failures }` |
| `src/staticAnalysis.ts` | Runs ESLint (target's own config, or the bundled fallback), returns `{ errors, warnings, issues }` |
| `src/mutationRunner.ts` | Runs StrykerJS, returns `{ mutationScore, killed, survived, survivedMutants }` — the key "are these tests actually meaningful" signal |
| `src/aggregator.ts` | Combines the three signals into a weighted 0-100 trust score |
| `src/reportGenerator.ts` | Renders the markdown (PR comment) and JSON (artifact) reports |
| `src/decisionGate.ts` | Pure `trustScore/threshold/iteration -> pass \| repair \| block` |
| `src/repairAgent.ts` | Sends the failure report to Gemini, applies the returned patch |
| `src/retryLoop.ts` | Bounded validate → repair → re-validate loop |
| `src/sandbox.ts` | `docker build`/`docker run` wrapper (BuildKit named contexts) |
| `src/githubClient.ts` | PR comments, labels, opening the staging→production promotion PR |
| `src/validate.ts` | In-container entrypoint (test + lint + mutation + score, one pass) |
| `src/orchestrate.ts` | Host entrypoint (retry loop + GitHub side effects) |
| `src/telemetry.ts` | Best-effort client for a sentinel-dashboard deployment; also the `SENTINEL_EVENT:` marker-line protocol between `validate.ts` and the host |
| `src/config.ts` | All thresholds/weights/budgets, env-driven |

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
- **Repair agent scope**: defaults to **production code only** — `SENTINEL_ALLOW_TEST_EDITS`
  must be explicitly set to `"true"` to let the repair agent touch files under
  `tests/`/`test/`/`__tests__/` or matching `*.test.*`/`*.spec.*`. Letting the repair agent
  edit tests by default would let it "fix" a low trust score by weakening the very tests
  mutation testing is meant to validate — exactly the failure mode this project exists to
  prevent.
- **Mutation testing unavailable → score, don't fail closed**: if Stryker can't run (missing
  tooling, config crash), its weight is redistributed across the other two signals rather
  than counted as 0. A sandbox/tooling problem isn't evidence the PR's tests are bad.
- **Test runner**: hardcoded to Jest for v1 (matches the current demo app). Swapping to
  Vitest or another runner means adding a sibling to `testRunner.ts` and selecting it based
  on the target's `package.json`.
- **Sentinel's own lint/mutation tooling is installed as ephemeral devDependencies of the
  target app** at Docker build time (`npm install --no-save eslint @stryker-mutator/core
  @stryker-mutator/jest-runner` inside `/app`), rather than kept in its own isolated
  `node_modules`. This sidesteps Stryker's jest-runner needing to resolve the target's own
  Jest config/binary from a sibling package — simpler, at the cost of transiently polluting
  the target's installed packages inside the (ephemeral, per-build) sandbox image only.
  Nothing is written back to the target app's own `package.json`/lockfile.
- **Native-binary prefetch (e.g. `mongodb-memory-server`)**: the Dockerfile runs
  `scripts/prefetch-mongo.js` at build time *if the target app provides one* — a narrow,
  demo-app-specific convention rather than a general pre-test-setup hook. A real v2 would
  generalize this to something like `sentinel.setup.js`.
- **Mutation testing has a bounded time budget (10 min by default), not an unbounded run**:
  for `sandbox-test`, full mutation testing (168 mutants across app.js/config/models/routes/
  server.js) takes on the order of an hour under `--cpus=1`, because its test setup spins up
  a real (in-memory) MongoDB process fresh for every mutant — that cost is paid ~168 times,
  not once. Rather than block the pipeline on that, `mutationRunner.ts` gives Stryker a fixed
  time budget and treats a still-running Stryker process as "unavailable" (see the redistribute-
  weight decision above), same as a crash. In production you'd want one of: (a) narrow
  `stryker.default.config.json`'s `mutate` patterns to just the highest-value business logic,
  (b) raise the budget and accept slower CI, or (c) fix it upstream — have the target app's
  own test setup reuse one `MongoMemoryServer` for the whole suite instead of one per run.
  (c) is a target-app testing-strategy change, out of scope here, but it's the real fix.
  **This also means the retry loop's real-world iteration time is dominated by mutation
  testing, not by the LLM call** — budget CI time accordingly.

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
| `SENTINEL_REPAIR_MODEL` | `gemini-3.5-flash-lite` |
| `SENTINEL_TEST_DIRS` | `tests,test,__tests__` |
| `SENTINEL_PR_NUMBER` | (read from `GITHUB_EVENT_PATH` if unset) |
| `SENTINEL_CHECKOUT_DIR` | `process.cwd()` — the target app's checked-out path |
| `SENTINEL_ORCHESTRATOR_DIR` | `process.cwd()` — this repo's checked-out path |
| `SENTINEL_PRODUCTION_BRANCH` / `SENTINEL_STAGING_BRANCH` | `production` / `staging` |
| `SENTINEL_DASHBOARD_URL` | unset (dashboard reporting skipped entirely) |
| `SENTINEL_DASHBOARD_TOKEN` | must match the dashboard's `DASHBOARD_INGEST_TOKEN` |
| `GEMINI_API_KEY` | required for the repair step to run |
| `GITHUB_TOKEN` | required to post PR comments / open the promotion PR |

## Local development

```bash
npm install
npm run typecheck
npm test           # unit tests for the pure modules (aggregator, decisionGate, reportGenerator)
npm run build
```

`testRunner.ts` / `staticAnalysis.ts` / `mutationRunner.ts` shell out to the target app's
own tooling, so they're best exercised against a real target app directory rather than
unit-tested in isolation — see the acceptance checks in `PLAN.md` in the parent project.

## Running the full sandbox locally

```bash
docker build -f sandbox/Dockerfile \
  --build-context target=/path/to/target-app \
  --build-context sentinel=. \
  -t sentinel-sandbox .

docker run --rm --memory=512m --cpus=1 --network=none sentinel-sandbox
```
