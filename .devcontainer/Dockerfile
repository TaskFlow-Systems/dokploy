# Dockerfile for DevContainer
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

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
    && su node -c "curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.4"

# Create workspace directory
WORKDIR /workspaces/dokploy

# Set up user permissions
USER node
