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

USER voir
EXPOSE 9000

# react-router-serve reads PORT; default in the package.json is 9000.
CMD ["sh", "-c", "PORT=${PORT:-9000} npx react-router-serve ./build/server/index.js"]
