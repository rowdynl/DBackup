# Base Image: Node.js 24 on Alpine Linux (small & secure)
FROM node:24-alpine AS base

# Install necessary system tools for backups
# mysql-client -> mysqldump
# mongodb-tools -> mongodump
# redis -> redis-cli (for Redis backups)
# samba-client -> smbclient (for SMB/CIFS storage)
# postgresql18-client -> pg_dump, pg_restore, psql (backward compatible with PG 12-18)

RUN apk update && \
    apk add --no-cache \
    mysql-client \
    postgresql18-client \
    lz4 \
    zstd \
    mongodb-tools \
    redis \
    samba-client \
    rsync \
    sshpass \
    openssh-client \
    openssl \
    curl \
    zip \
    su-exec

# Enable corepack for pnpm support and symlink PostgreSQL 18 binaries
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate && \
    ln -sf /usr/libexec/postgresql18/pg_dump /usr/local/bin/pg_dump && \
    ln -sf /usr/libexec/postgresql18/pg_restore /usr/local/bin/pg_restore && \
    ln -sf /usr/libexec/postgresql18/psql /usr/local/bin/psql

# Validate pg_dump version resolves correctly (fail-fast on broken symlinks/packages)
RUN pg_dump --version | grep -q 'PostgreSQL) 18\.' || \
    (echo "ERROR: pg_dump version validation failed! Check PostgreSQL 18 client package." && exit 1)

# Install InfluxDB CLI tools for backup/restore support
# influxd -> v1 backup/restore (influxd backup/restore -portable)
# influx  -> v2 backup/restore (influx backup/restore)
# gcompat provides the glibc compatibility layer for these pre-built binaries on Alpine/musl
ARG TARGETARCH
RUN apk add --no-cache gcompat && \
    ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -fsSL "https://dl.influxdata.com/influxdb/releases/influxdb-1.8.10_linux_${ARCH}.tar.gz" \
        -o /tmp/influxdb1.tar.gz && \
    mkdir -p /tmp/influxdb1 && \
    tar -xzf /tmp/influxdb1.tar.gz -C /tmp/influxdb1/ && \
    find /tmp/influxdb1/ -name influxd -type f -exec install -m 755 {} /usr/local/bin/influxd \; && \
    curl -fsSL "https://dl.influxdata.com/influxdb/releases/influxdb2-client-2.7.5-linux-${ARCH}.tar.gz" \
        -o /tmp/influxdb2cli.tar.gz && \
    mkdir -p /tmp/influxdb2cli && \
    tar -xzf /tmp/influxdb2cli.tar.gz -C /tmp/influxdb2cli/ && \
    find /tmp/influxdb2cli/ -name influx -type f -exec install -m 755 {} /usr/local/bin/influx \; && \
    rm -rf /tmp/influxdb1.tar.gz /tmp/influxdb1 /tmp/influxdb2cli.tar.gz /tmp/influxdb2cli

# 1. Install Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 2. Builder Phase
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Environment variables for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Generate Prisma Client, build Next.js app, and compile custom server
# --mount=type=cache persists the Next.js incremental build cache (.next/cache)
# across Docker builds via GitHub Actions cache (type=gha,mode=max in release.yml).
# Next.js reuses webpack/SWC artefacts for unchanged modules, cutting rebuild time significantly.
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
    pnpm prisma generate && pnpm run build && npx tsc -p tsconfig.server.json

# 3. Runner Phase (The actual image)
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Default environment variables (can be overridden at runtime)
ENV DATABASE_URL="file:/data/db/dbackup.db"
ENV TZ="UTC"
ENV LOG_LEVEL="info"
ENV PUID=1001
ENV PGID=1001

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built files (--link for better layer caching)
COPY --from=builder --link --chown=1001:1001 /app/public ./public
COPY --from=builder --link --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --link --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --link --chown=1001:1001 /app/prisma ./prisma

# Create runtime data directory + install Prisma CLI for migrations
# Note: pnpm add -g runs as root, so we must chown /pnpm to the runtime user
# to avoid "Can't write to @prisma/engines" errors at container startup
# Prisma version is read from package.json to stay in sync automatically
COPY --from=builder --link /app/package.json /tmp/package.json
RUN mkdir -p /data/storage/avatars /data/db /data/certs && \
    chown -R 1001:1001 /data && \
    PRISMA_VERSION=$(node -e "console.log(require('/tmp/package.json').devDependencies.prisma.replace(/[\^~>=<]/g,''))") && \
    pnpm add -g prisma@${PRISMA_VERSION} && \
    rm /tmp/package.json && \
    chown -R 1001:1001 /pnpm

# Copy compiled custom HTTPS server (replaces default Next.js server entry point)
COPY --from=builder --link --chown=1001:1001 /app/custom-server.js ./custom-server.js

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Health check: verify app + database are reachable
# Uses --insecure for self-signed certs; falls back to http if DISABLE_HTTPS=true
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -fk https://localhost:3000/api/health 2>/dev/null || curl -f http://localhost:3000/api/health || exit 1

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DISABLE_HTTPS="false"
ENV DATA_DIR="/data"

ENTRYPOINT ["docker-entrypoint.sh"]
