# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────────────────
# Voir — multi-stage Dockerfile
#
# Build:    docker build -t voir .
# Run:      docker run --rm -p 9000:9000 --env-file .env voir
# Compose:  docker compose up --build
# ──────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22

# ── deps: install all (dev + prod) dependencies ──────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build: compile the React Router SSR bundle ──────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Frontend telemetry (faro-recipe.md — estate observability): vite bakes
# VITE_FARO_* into the JS bundle at build time. Build with e.g.
#   docker build --build-arg VITE_FARO_ENABLED=true \
#     --build-arg VITE_FARO_API_KEY="$(cat ~/code/infra/keys/faro-api-key)" -t voir .
# The API key is a spam bar by design — it ships in the public bundle;
# the origin CORS allowlist + the collector's rate limit are the real bar.
ARG VITE_FARO_ENABLED=""
ARG VITE_FARO_URL="https://faro.stackunderflow.no/collect"
ARG VITE_FARO_API_KEY=""
ENV VITE_FARO_ENABLED=$VITE_FARO_ENABLED \
    VITE_FARO_URL=$VITE_FARO_URL \
    VITE_FARO_API_KEY=$VITE_FARO_API_KEY

RUN npm run build

# ── runtime: slim image with prod deps only ─────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=9000

# Run as non-root for safety
RUN useradd --system --uid 1001 --shell /usr/sbin/nologin --create-home voir

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Built app only — the acp-spawn launcher runs outside the container.
COPY --from=build /app/build ./build

# Same server shape as the devbox production unit (deploy/voir.service:
# "npx tsx bin/server.ts"): express + React Router SSR with the request-log
# /span middleware, /healthz, and the /api/voice + /api/tts WebSocket
# endpoints — all of which react-router-serve (the former CMD) bypassed.
tsx is a prod dependency, so this needs nothing extra.
USER voir
EXPOSE 9000

# tsx reads PORT; bin/server.ts defaults to 9000.
CMD ["npx", "tsx", "bin/server.ts"]
