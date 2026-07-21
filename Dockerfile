# Production image for AIMANCER (aimancer.cpuchip.net) — ARK PIVOT.
# MULTI-STAGE: a golang builder compiles the deterministic Starlark script
# engine from cpuchip/aimancer-go (pinned by ENGINE_REF — the same identity
# the server stamps into every room's replay header), then the node runtime
# builds the Vite client and runs the server, which spawns the engine as ONE
# NDJSON subprocess (server/engine.ts).
#
# Local dev needs no Docker: server/engine.ts builds the engine from the
# sibling ../aimancer-go checkout with `go build` (cached), or honors
# AIMANCER_ENGINE_BIN. See README.
#
# Adapted from kernel-panic's Dockerfile (the house pattern).

# ── stage 1: the script engine (Go) ──────────────────────────────────────────
FROM golang:1.25-alpine AS engine
RUN apk add --no-cache git
# Pin the engine to a commit — bump deliberately; replays record this identity.
ARG ENGINE_REF=602cf10
RUN git clone https://github.com/cpuchip/aimancer-go.git /src  && cd /src && git checkout "$ENGINE_REF"  && CGO_ENABLED=0 go build -trimpath -o /out/aimancer-engine ./cmd/aimancer-engine

# ── stage 2: client build + server runtime (Node) ────────────────────────────
FROM node:lts-alpine
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --legacy-peer-deps

# git is installed so the build can stamp the commit hash (VITE_GIT_SHA); .git is
# copied in (un-ignored) for that, then removed. /version echoes it — the oracle.
RUN apk add --no-cache git
COPY . .
RUN git config --global --add safe.directory /app  && export VITE_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"  && echo "[build] VITE_GIT_SHA=$VITE_GIT_SHA"  && npm run build  && rm -rf .git

COPY --from=engine /out/aimancer-engine /usr/local/bin/aimancer-engine
ENV AIMANCER_ENGINE_BIN=/usr/local/bin/aimancer-engine

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3   CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["npm", "run", "serve"]
