# =============================================================================
# Admin frontend - production image
# -----------------------------------------------------------------------------
# Multi-stage build:
#   1. node:20-alpine compiles the Vite TS bundle into static assets
#      in /app/build (Vite outDir is set to "build" in vite.config.ts).
#   2. nginx:alpine serves those static assets on port 80.
#
# Vite inlines `import.meta.env.VITE_*` at BUILD time, so the API/WS URLs
# must be passed as build args - docker-compose.prod.yml wires them from
# the host .env via the `build.args` block. Re-build (not just restart) is
# required whenever the public hostname changes.
# =============================================================================

# ---------- stage 1: build ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first, leveraging Docker layer cache
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Build args -> baked into the Vite bundle
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_ADMIN_WS_URL
ENV VITE_API_URL=$VITE_API_URL \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_ADMIN_WS_URL=$VITE_ADMIN_WS_URL

# Copy source and build
COPY . .
RUN npm run build

# ---------- stage 2: serve ----------
FROM nginx:1.27-alpine

# Replace the default site config with our SPA-aware one
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Vite outDir is "build" (see vite.config.ts), NOT "dist"
COPY --from=builder /app/build /usr/share/nginx/html

EXPOSE 80

# nginx:alpine already CMDs ["nginx", "-g", "daemon off;"]
