# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base

# Install system dependencies (git for GitOps checkouts, curl for healthchecks, ca-certificates for HTTPS)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev --no-audit --no-fund

# Copy application code
COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Probot exposes /ping returning "PONG"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/ping || exit 1

CMD ["npm", "start"]

