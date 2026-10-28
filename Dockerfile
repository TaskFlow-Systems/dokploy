# syntax=docker/dockerfile:1
FROM node:26.12.1-bookworm-slim AS base
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.4 \
    && ln -sf "$BUN_INSTALL/bin/bun" "$BUN_INSTALL/bin/bunx" \
    && npm install -g node-gyp@13.0.1

FROM base AS deps
RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app

# Copy workspace manifests first so the dependency install layers stay cached
# unless dependencies actually change.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/dokploy/package.json ./apps/dokploy/package.json
COPY apps/schedules/package.json ./apps/schedules/package.json
COPY packages/server/package.json ./packages/server/package.json

# Production dependencies get their own clean tree. Installing them over the
# build-stage install kept Bun's isolated store (node_modules/.bun, 1.6 GB) in
# the image, and packages/server resolved its imports through that store, so
# the panel loaded every shared dependency into memory twice.
FROM deps AS prod-deps
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile --linker hoisted \
    && rm -f node_modules/dokploy node_modules/@dokploy/api node_modules/@dokploy/schedules \
    && mkdir -p packages/server/node_modules

FROM deps AS build
ARG DOKPLOY_OFFICIAL_VERSION=v0.29.8
ARG DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_local
ENV DOKPLOY_OFFICIAL_VERSION=$DOKPLOY_OFFICIAL_VERSION
ENV DOKPLOY_FORK_VERSION=$DOKPLOY_FORK_VERSION

# Install dependencies
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

# Copy the rest of the source. Changes here no longer reinstall dependencies.
COPY . /usr/src/app

# Deploy only the dokploy app

ENV NODE_ENV=production
RUN bun run --filter './packages/server' build
# The webpack cache (~700 MB) only speeds up the next build; keep it out of the image.
RUN bun run --filter './apps/dokploy' build \
    && rm -rf apps/dokploy/.next/cache

FROM base AS dokploy
WORKDIR /app

# Set production
ARG DOKPLOY_OFFICIAL_VERSION=v0.29.8
ARG DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_local
ENV NODE_ENV=production
ENV DOKPLOY_OFFICIAL_VERSION=$DOKPLOY_OFFICIAL_VERSION
ENV DOKPLOY_FORK_VERSION=$DOKPLOY_FORK_VERSION

RUN apt-get update && apt-get install -y tini curl unzip zip apache2-utils iproute2 rsync jq git-lfs && git lfs install && rm -rf /var/lib/apt/lists/*

# Copy only the necessary files
COPY --from=build /usr/src/app/apps/dokploy/.next ./.next
COPY --from=build /usr/src/app/apps/dokploy/dist ./dist
COPY --from=build /usr/src/app/apps/dokploy/next.config.mjs ./next.config.mjs
COPY --from=build /usr/src/app/apps/dokploy/public ./public
COPY --from=build /usr/src/app/apps/dokploy/package.json ./package.json
COPY --from=build /usr/src/app/apps/dokploy/drizzle ./drizzle
COPY .env.production ./.env
COPY --from=build /usr/src/app/apps/dokploy/components.json ./components.json
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --from=prod-deps /usr/src/app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /usr/src/app/packages/server/package.json ./packages/server/package.json
COPY --from=build /usr/src/app/packages/server/dist ./packages/server/dist


# Install docker
ARG DOCKER_VERSION=29.8.2
RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh --version "$DOCKER_VERSION" && rm get-docker.sh

# Install rclone
ARG RCLONE_VERSION=1.75.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" -o /tmp/rclone.zip \
    && unzip -q /tmp/rclone.zip -d /tmp \
    && install -m 0755 "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /usr/bin/rclone \
    && rm -rf /tmp/rclone.zip "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64" /var/lib/apt/lists/*

# Install Nixpacks and tsx
# | VERBOSE=1 VERSION=1.21.0 bash

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && NIXPACKS_VERSION="$NIXPACKS_VERSION" ./install.sh -y \
    && rm install.sh \
    && bun install -g tsx

# Install Railpack
ARG RAILPACK_VERSION=0.40.1
RUN curl -sSL https://railpack.com/install.sh \
    | RAILPACK_VERSION="$RAILPACK_VERSION" bash -s -- --yes --bin-dir /usr/local/bin

# Install buildpacks
COPY --from=buildpacksio/pack:0.40.9 /usr/local/bin/pack /usr/local/bin/pack

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# tini reaps HEALTHCHECK child processes that Node (as PID 1) leaves defunct.
ENTRYPOINT ["/usr/bin/tini", "--"]

  CMD ["sh", "-c", "bun run wait-for-postgres && exec bun run start"]
