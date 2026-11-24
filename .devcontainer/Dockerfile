# Dockerfile for DevContainer
FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5

# Install essential packages
RUN apt-get update && apt-get install -y \
    curl \
    bash \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set up Bun
ENV BUN_INSTALL="/home/node/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
RUN mkdir -p "$BUN_INSTALL" \
    && chown -R node:node "$BUN_INSTALL" \
    && su node -c "curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.5"

# Create workspace directory
WORKDIR /workspaces/dokploy

# Set up user permissions
USER node
