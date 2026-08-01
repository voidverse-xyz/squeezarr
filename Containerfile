# Production image for Squeezarr — Express backend (mongod + ffmpeg + job queue) that also
# serves the prebuilt Next.js UI. One image, one process, one port.
#
# Hardening choices:
#   - Pinned, slim base (not `node:latest`) to shrink the attack surface and keep builds reproducible.
#   - Multi-stage: build tooling, the Next.js toolchain, and dev deps never reach the final image.
#   - Runs as the unprivileged `node` user (uid 1000), never root.
#   - tini as PID 1 for correct signal handling and reaping of ffmpeg child processes.
#   - No secrets baked in; runtime state lives in the /config and /data volumes.
#
# Build:  podman build -t squeezarr -f Containerfile .
# Run:
#   podman volume create squeezarr-config
#   podman run -d --name squeezarr -p 3000:3000 \
#       -v squeezarr-config:/config -v ./data:/data squeezarr
#
# State lives in MongoDB. The backend starts a bundled mongod (data under /config/mongodb,
# bound to loopback only on the fixed local port). Nothing outside the container connects to it.
#
# Mode is env-driven (same image, same `node backend/server.js` entrypoint):
#   - default (no HOST_IP): monitor — mongod + UI/API + the job queue, plus an in-process runner.
#   - HOST_IP set: runner-only — starts nothing but a runner that connects to the monitor at
#     HOST_IP over WebSocket and drives ffmpeg. A runner needs only ffmpeg and the SAME /data
#     mount as the monitor; no /config, no mongod, no HTTP (so the healthcheck below is monitor-only).
#
# The container runs as uid 1000 (node). A named /config volume inherits safe image
# ownership. Bind-mounted media must grant uid 1000 the read/write/rename access required by
# the selected transcode mode; the image never changes ownership anywhere in /data.

# ---------- base ----------
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /server

# ---------- builder: install all workspaces, build the static UI, drop dev deps ----------
FROM base AS builder

# Workspace manifests first (better layer caching), then install from the lockfile.
# --include=dev forces dev deps in even with NODE_ENV=production, so the build never breaks.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --include=dev

# Sources.
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

# Build the Next.js static export (frontend/out), then drop dev deps from node_modules.
RUN npm run build -w frontend \
    && npm prune --omit=dev

# ---------- runner: minimal runtime ----------
FROM base AS runner

# ffmpeg/ffprobe for probing + transcoding; tini for init duties; mongodb-org-server so the
# backend can run its local mongod. The base is bookworm, so the MongoDB 7.0 apt repo matches
# directly. curl/gnupg are purged afterward to keep the image lean.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg ffmpeg tini; \
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
        | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor; \
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
        > /etc/apt/sources.list.d/mongodb-org-7.0.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends mongodb-org-server; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

ENV CONFIG_DIR=/config \
    FRONTEND_DIR=/server/frontend/out

# Copy production deps, the backend + shared source, and the prebuilt UI, owned by the
# non-root user. (node_modules carries the workspace symlinks for `shared`.)
COPY --from=builder --chown=node:node /server/node_modules ./node_modules
COPY --from=builder --chown=node:node /server/shared ./shared
COPY --from=builder --chown=node:node /server/backend ./backend
COPY --from=builder --chown=node:node /server/frontend/out ./frontend/out
COPY --from=builder --chown=node:node /server/package.json ./package.json

# Volume mount points, writable by the node user.
RUN mkdir -p /config /data && chown node:node /config /data
VOLUME ["/config", "/data"]

USER node
EXPOSE 3000

# Liveness probe: the server is healthy once it answers an API request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "backend/server.js"]
