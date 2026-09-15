# syntax=docker/dockerfile:1.7
#
# Two named build contexts are required (BuildKit, Docker 23+):
#   target   - the app being validated (checked out PR code)
#   sentinel - this repo's root (sentinel-orchestrator/)
#
# docker build -f sandbox/Dockerfile \
#   --build-context target=<target-app-path> \
#   --build-context sentinel=<this-repo-path> \
#   -t <tag> .
#
# Deps are installed at BUILD time (network available in CI) so the sandbox
# can run fully offline (`docker run --network=none`) at validation time.

FROM node:22-slim AS orchestrator-build
WORKDIR /orchestrator
COPY --from=sentinel package.json package-lock.json ./
RUN npm ci
COPY --from=sentinel tsconfig.json ./
COPY --from=sentinel src ./src
RUN npm run build

FROM node:22-slim AS sandbox
WORKDIR /app

# Some target apps (e.g. ones using mongodb-memory-server) need a native
# binary prefetched at build time since the sandbox has no network at runtime.
# Convention: if the target ships scripts/prefetch-mongo.js, we run it.
# procps provides `ps`, which Stryker's worker-process cleanup shells out to
# (crashes with an unhandled ENOENT on Node slim images without it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libcurl4 procps \
  && rm -rf /var/lib/apt/lists/*
ENV MONGOMS_DOWNLOAD_DIR=/app/.cache/mongodb-binaries
ENV MONGOMS_VERSION=7.0.14
ENV MONGOMS_DISABLE_POSTINSTALL=1

COPY --from=target package.json package-lock.json* ./
RUN npm ci

# Sentinel's own analysis tooling, installed as ephemeral devDeps of the
# target app so `npx eslint` / `npx stryker` resolve locally without network
# once --network=none is applied.
RUN npm install --no-save --no-audit --no-fund \
    eslint@9 @stryker-mutator/core @stryker-mutator/jest-runner

COPY --from=target . .
RUN if [ -f scripts/prefetch-mongo.js ]; then \
      mkdir -p "$MONGOMS_DOWNLOAD_DIR" && node scripts/prefetch-mongo.js; \
    fi

COPY --from=orchestrator-build /orchestrator/dist /opt/sentinel/dist
COPY --from=sentinel sandbox/eslint.default.config.mjs sandbox/stryker.default.config.json /opt/sentinel/

ENV SENTINEL_TARGET_DIR=/app
CMD ["node", "/opt/sentinel/dist/validate.js", "/app"]
