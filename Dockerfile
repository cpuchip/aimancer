# Production image for AIMANCER (aimancer.cpuchip.net).
# One container: builds the Vite client (dist/) and runs the Node server that
# serves it + /healthz + /version. Adapted from kernel-panic's Dockerfile
# (the house pattern).

FROM node:lts-alpine
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --legacy-peer-deps

# git is installed so the build can stamp the commit hash (VITE_GIT_SHA); .git is
# copied in (un-ignored) for that, then removed. /version echoes it — the oracle.
RUN apk add --no-cache git
COPY . .
RUN git config --global --add safe.directory /app \
 && export VITE_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" \
 && echo "[build] VITE_GIT_SHA=$VITE_GIT_SHA" \
 && npm run build \
 && rm -rf .git

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["npm", "run", "serve"]
