# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

# Install system dependencies (git for GitOps checkouts)
RUN apk add --no-cache git curl

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/probot || exit 1

CMD ["npm", "start"]
