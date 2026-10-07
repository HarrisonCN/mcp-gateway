# package-lock.json is required by `npm ci`
# Node 22: needed for the optional audit log (built-in node:sqlite)
FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Production image ─────────────────────────────────────────────────────────

FROM node:26-alpine AS runner

LABEL org.opencontainers.image.source="https://github.com/HarrisonCN/mcp-gateway" \
      org.opencontainers.image.description="Gateway for MCP servers: routing, auth, rate limits, monitoring, /mcp endpoint" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY dashboard/index.html ./dashboard/index.html

# Writable location for the optional audit log (audit.path: /app/data/audit.db)
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# Drop root privileges
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/v1/health/live || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
