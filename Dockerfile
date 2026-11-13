# syntax=docker/dockerfile:1
# Debian 13: Debian 12 leaves the critical zlib1g CVE-2023-45853 and dozens of
# high findings unfixed. The tag is pinned to its multi-arch index digest, the
# same in every Dockerfile (component-versions-sync.test.ts).
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
# Bun, Nixpacks and Railpack come from GitHub releases; the script falls back to
# the GitHub API when github.com fails to serve them.
COPY scripts/github-release-asset.sh /usr/local/bin/github-release-asset
# The Node base image can lag behind a Debian security update by days, and the
# image scan fails on any fixed finding, so the base stage takes every update.
# The registry build cache would keep this layer until the base image changes;
# CI passes the UTC date, so the first build of a day takes that day's updates.
ARG DEBIAN_UPDATES_DAY=
RUN echo "Debian updates of ${DEBIAN_UPDATES_DAY:-the build day}" \
    && apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends apt bash ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && bun_arch="$(uname -m | sed 's/x86_64/x64/')" \
    && github-release-asset oven-sh/bun bun-v1.4.4 "bun-linux-$bun_arch.zip" /tmp/bun.zip \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -D -m 0755 "/tmp/bun/bun-linux-$bun_arch/bun" "$BUN_INSTALL/bin/bun" \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && ln -sf "$BUN_INSTALL/bin/bun" "$BUN_INSTALL/bin/bunx" \
    && npm install -g node-gyp@13.1.0

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
#
# The @trpc packages list typescript as a required peer, so the production
# install also brings the TypeScript 7 compiler, a Go binary the panel never runs.
#
# sharp is an optional dependency of next, used only behind /_next/image, which
# images.unoptimized turns off. It brings libvips, 38 MB of C the panel never runs.
FROM deps AS prod-deps
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile --linker hoisted \
    && rm -f node_modules/dokploy node_modules/@dokploy/api node_modules/@dokploy/schedules \
    && rm -rf node_modules/typescript node_modules/@typescript node_modules/.bin/tsc \
    && rm -rf node_modules/sharp node_modules/@img \
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

# Recommends would add systemd, dbus and X11 libraries; the packages the panel
# calls are listed instead: openssh-client for git over SSH and ssh-keyscan,
# procps for pkill when a deployment is cancelled.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl unzip zip apache2-utils iproute2 rsync jq git-lfs openssh-client procps xz-utils netbase \
    && git lfs install \
    && rm -rf /var/lib/apt/lists/*

# The panel runs on Bun, with Node kept for going back. npm, npx and node-gyp only serve the build
# stages, and npm ships its own copies of packages with open advisories.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/node-gyp \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/node-gyp

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


# The panel drives the host's Docker daemon through the mounted socket, so it
# needs only the CLI and its buildx and compose plugins. get.docker.com would
# also install the engine, containerd and the rootless extras: unused binaries
# that scanners report.
ARG DOCKER_VERSION=29.9.3
RUN . /etc/os-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "docker-ce-cli=5:${DOCKER_VERSION}-1~debian.${VERSION_ID}~${VERSION_CODENAME}" docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Install rclone
ARG RCLONE_VERSION=1.76.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" -o /tmp/rclone.zip \
    && unzip -q /tmp/rclone.zip -d /tmp \
    && install -m 0755 "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /usr/bin/rclone \
    && rm -rf /tmp/rclone.zip "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64" /var/lib/apt/lists/*

# Install Nixpacks and tsx

ARG NIXPACKS_VERSION=1.41.0
RUN github-release-asset railwayapp/nixpacks "v$NIXPACKS_VERSION" "nixpacks-v$NIXPACKS_VERSION-$(uname -m)-unknown-linux-musl.tar.gz" /tmp/nixpacks.tar.gz \
    && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks \
    && rm /tmp/nixpacks.tar.gz \
    && bun install -g tsx

# Install Railpack
ARG RAILPACK_VERSION=0.43.0
RUN github-release-asset railwayapp/railpack "v$RAILPACK_VERSION" "railpack-v$RAILPACK_VERSION-$(uname -m | sed s/aarch64/arm64/)-unknown-linux-musl.tar.gz" /tmp/railpack.tar.gz \
    && tar -xzf /tmp/railpack.tar.gz -C /usr/local/bin railpack \
    && rm /tmp/railpack.tar.gz

# Railpack downloads the mise version it pins (core/mise/version.txt of its
# release) from github.com on its first build and keeps it at
# /tmp/railpack/mise/mise-<version>. Placed there beforehand, builds on the
# panel do not depend on github.com. Keep this at Railpack's version.
ARG MISE_VERSION=2026.10.14
RUN mise_arch="$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')" \
    && github-release-asset jdx/mise "v$MISE_VERSION" "mise-v$MISE_VERSION-linux-$mise_arch-musl.tar.gz" /tmp/mise.tar.gz \
    && mkdir -p /tmp/railpack/mise \
    && tar -xzf /tmp/mise.tar.gz -O mise/bin/mise > "/tmp/railpack/mise/mise-$MISE_VERSION" \
    && chmod 0755 "/tmp/railpack/mise/mise-$MISE_VERSION" \
    && rm /tmp/mise.tar.gz

# Install buildpacks
COPY --from=buildpacksio/pack:0.40.11 /usr/local/bin/pack /usr/local/bin/pack

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# tini reaps HEALTHCHECK child processes that the server (as PID 1) leaves defunct.
ENTRYPOINT ["/usr/bin/tini", "--"]

# The server runs on Bun: on the same panel it answered API calls 7-24% and
# pages 14-19% faster than on Node, started in 2.8 s instead of 6.2 s and
# peaked at about half the memory under load, while holding 50-70 MB more at
# rest. --smol runs Bun's GC more often, a few percent faster and lighter
# there. Bun reads /app/.env by itself, as dotenv did for Node. Node stays in
# the image: a service command of
#   sh -c "node -r dotenv/config dist/migration.mjs && exec node -r dotenv/config dist/server.mjs"
# runs the same build on Node.
  CMD ["sh", "-c", "bun dist/wait-for-postgres.mjs && bun dist/migration.mjs && exec bun --smol dist/server.mjs"]
