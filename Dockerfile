# Worker image for Railway. Node 22 is pinned here (the base image); pnpm comes from the
# packageManager field via corepack. The worker runs TypeScript directly with tsx (no build step).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    CI=true \
    TZ=UTC \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable

WORKDIR /app

# Install dependencies first (cached unless manifests or the lockfile change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/emails/package.json packages/emails/
RUN pnpm install --frozen-lockfile --prod

# Source and migrations. .dockerignore keeps out .env, data/ (holdings), node_modules and git.
COPY packages ./packages
COPY apps ./apps

WORKDIR /app/apps/worker
# Same as `pnpm worker`, but node is PID 1 so Railway's SIGTERM reaches the worker's
# shutdown handler directly (pnpm in between can swallow signals).
CMD ["node", "--import", "tsx", "src/index.ts"]
