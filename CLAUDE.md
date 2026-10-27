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

One GitHub release `agenthits-vX.Y.Z` covers a batch of work, not a single PR (owner's decision 2026-10-27). Every push to `AgentHits-Dev` builds the image through `.github/workflows/agenthits-release.yml` (`agenthits-dev`, `agenthits-dev-<sha12>`), and panels show such a build as `agenthits-vX.Y.Z-N-g<sha12>`: the previous release plus N commits. A push cuts the release once 20 PRs (`RELEASE_EVERY`, first-parent commits) have been merged since the previous release; to release a finished batch sooner, run `gh workflow run agenthits-release.yml --repo TaskFlow-Systems/dokploy --ref AgentHits-Dev`. Several PRs that belong together can also be merged as one combined PR. The `agenthits-` prefix keeps fork tags apart from upstream Dokploy `v0.x` tags. The version goes up by patch, by minor when a PR title in the batch starts with `feat`, and by major only through a manual run with `bump: major`. The release notes are the title and body of every PR merged since the previous release, so write each PR description for someone reading the release. The image of a release is `ghcr.io/agenthits/dokploy:agenthits-vX.Y.Z` and panels show that tag as the fork version; `agenthits-dev` always points at the newest build. `.github/workflows/agenthits-ghcr-retention.yml` deletes old GHCR versions weekly but never a release tag, `agenthits-dev` or `buildcache`.

## Dependencies

`.github/workflows/deps-auto-update.yml` runs every day at 03:00 UTC (manually: `gh workflow run deps-auto-update.yml --repo TaskFlow-Systems/dokploy --ref AgentHits-Dev`). It runs `bun update --recursive` within the `package.json` ranges (minor and patch, direct and transitive packages, versions at least one day old), then `bun audit`, and keeps one PR `зависимости: автообновление библиотек` from `deps/auto-update` into `AgentHits-Dev`, rebuilt daily until it is merged. It starts `pull-request.yml` on the branch through `workflow_dispatch`; judge the PR by that run. It never merges. The same workflow runs in the owner's other projects; it replaced Dependabot for Bun, which moves only direct dependencies. It needs "Allow GitHub Actions to create and approve pull requests" in the repo's Actions settings.

- Held packages stay pinned to exact versions (`better-auth`, `@better-auth/*`, `stripe`, `@stepperize/react`, `@dokploy/trpc-openapi`) or `~` (`ssh2`), and the root `overrides` are exact, so the workflow does not move them. Keep new holds pinned the same way.
- Major updates are done by hand, one PR each (the `dokploy-upgrader` agent), with `bun add <pkg>@<ver> --minimum-release-age=86400`.
- The one-day age is `minimumReleaseAge` in `bunfig.toml` and `MIN_RELEASE_AGE` in the workflow; change both together.
- A commit pushed to the branch of the open PR stops its daily rebuild until the PR is merged or closed.
- `.github/workflows/dependency-audit.yml` runs `bun audit` every Monday for advisories published between updates.
