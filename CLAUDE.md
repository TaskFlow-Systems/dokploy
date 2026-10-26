## Code style
- Don't write comments that restate what the code already says.
- Comment only the "why" when something isn't obvious: workarounds,
  counterintuitive decisions, constraints from an external API.
- No section-divider comments like `// --- Helpers ---`.
- Don't leave comments describing the change you just made.

## Ports and certificates

Порт 80 на серверах не открываем никогда. Сертификаты обновляются только через порт 443 (tlsChallenge). Не добавлять httpChallenge и публикацию порта 80 ни в код, ни в установщик.

## Pull requests

Every pull request targets `AgentHits-Dev`, including a PR that builds on another open PR. Checks run only for that base, so a PR stacked on another branch gets none. When one PR depends on another, say so in the description; do not change the base.

## Releases

Every push to `AgentHits-Dev` (every merged PR) gets a GitHub release `agenthits-vX.Y.Z` from `.github/workflows/agenthits-release.yml`. The `agenthits-` prefix keeps fork tags apart from upstream Dokploy `v0.x` tags. The version goes up by patch, by minor when a merged PR title starts with `feat`, and by major only through a manual run with `bump: major`. The release notes are the merged PR's title and body, so write the PR description for someone reading the release. The image of a release is `ghcr.io/agenthits/dokploy:agenthits-vX.Y.Z` and panels show that tag as the fork version; `agenthits-dev` always points at the newest build. `.github/workflows/agenthits-ghcr-retention.yml` deletes old GHCR versions weekly but never a release tag, `agenthits-dev` or `buildcache`.
