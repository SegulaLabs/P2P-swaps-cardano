# syntax=docker/dockerfile:1
# Production image for the non-custodial backend (Fastify, preprod only).
# Build context is the REPO ROOT (npm workspaces need the root lockfile):
#   docker build -f backend/Dockerfile .
# Normally you don't run this by hand — the root docker-compose.yml does.
#
# The compiled contract blueprint (src/protocol/plutus.json) is committed,
# so no Aiken toolchain is needed here. `npm ci --workspace backend` only
# installs the backend's deps — root devDependencies (aiken) are skipped.

# ---- runtime dependencies only (what ships in the final image) ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
RUN npm ci --workspace backend --omit=dev --no-audit --no-fund

# ---- build (needs devDependencies: typescript) ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
RUN npm ci --workspace backend --no-audit --no-fund
COPY backend/ backend/
RUN npm run build --workspace backend

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Whole deps tree (root node_modules + workspace layout), then the build.
COPY --from=deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/backend/dist /app/backend/dist
USER node
WORKDIR /app/backend
EXPOSE 3001
CMD ["node", "dist/index.js"]
