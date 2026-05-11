# =============================================================================
# Student frontend - production image
# -----------------------------------------------------------------------------
# Multi-stage build:
#   1. node:20-alpine compiles the Vite bundle into /app/dist.
#   2. nginx:alpine serves the static assets on port 80.
#
# Vite inlines `import.meta.env.VITE_*` at BUILD time, so every URL that
# the student SPA talks to (API, WebSocket, admin redirect) is passed as a
# build arg from docker-compose.prod.yml -> host .env.
#
# Note on VITE_API_URL: unlike the admin SPA which expects the FULL
# `/api/v1/` base, the student code paths (services/examService.js, etc.)
# append `/api/v1/...` themselves, so this should be the ORIGIN only -
# e.g. `https://api.<host>.nip.io`, NO trailing /api/v1.
# =============================================================================

# ---------- stage 1: build ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first - separate layer so a code change doesn't bust npm cache
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Build args -> baked into the Vite bundle.
# Keep this list aligned with the VITE_* keys actually consumed in src/.
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_ADMIN_URL
ENV VITE_API_URL=$VITE_API_URL \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_ADMIN_URL=$VITE_ADMIN_URL

COPY . .
RUN npm run build

# ---------- stage 2: serve ----------
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
