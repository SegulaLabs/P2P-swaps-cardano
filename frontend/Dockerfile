# syntax=docker/dockerfile:1
# Production image for the Next.js frontend (preprod only).
# Build context is the REPO ROOT (npm workspaces need the root lockfile):
#   docker build -f frontend/Dockerfile .
# Normally you don't run this by hand — the root docker-compose.yml does.
#
# The browser talks same-origin to this server, which proxies /backend/* to
# BACKEND_INTERNAL_URL (runtime env, set by docker-compose.yml) — so the app
# works under any hostname/IP without rebuilding. NEXT_PUBLIC_API_URL stays
# empty by default; set it at build time only to make browsers call a backend
# at a different address than the site itself.

# ---- runtime dependencies only (what ships in the final image) ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --omit=dev --no-audit --no-fund

# ---- build (needs devDependencies: typescript etc.) ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --no-audit --no-fund
COPY frontend/ frontend/
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_CARDANO_NETWORK=preprod
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_CARDANO_NETWORK=$NEXT_PUBLIC_CARDANO_NETWORK
RUN npm run build --workspace frontend

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/frontend/.next /app/frontend/.next
COPY --chown=node:node frontend/next.config.mjs /app/frontend/
COPY --chown=node:node frontend/public /app/frontend/public
USER node
WORKDIR /app/frontend
EXPOSE 3000
CMD ["/app/node_modules/.bin/next", "start", "-p", "3000"]
