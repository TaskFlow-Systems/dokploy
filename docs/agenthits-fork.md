# AgentHits Dokploy Fork

## Русский

AgentHits Dokploy - это форк официального Dokploy, который собирается из ветки
`AgentHits-Dev` и публикуется как:

```text
ghcr.io/agenthits/dokploy:agenthits-dev
```

Официальная версия и версия форка показываются отдельно:

```text
Official: v0.29.8
Fork: agenthits-vX.Y.Z
```

`agenthits-vX.Y.Z` — тег GitHub release, в который вошла сборка: каждый
влитый в `AgentHits-Dev` PR выпускает новый релиз. Сборка, собранная вручную
между релизами, показывается как `agenthits-vX.Y.Z-<коммитов после релиза>-g<short-sha>`.

### Что это дает

- Видно, какая официальная версия лежит в основе установленного сервера.
- Видно, какая именно сборка форка установлена поверх этой официальной версии.
- Можно безопаснее сверять VPS, GitHub Actions build и pinned Docker image tag.
- Официальный `package.json` version остается semver-версией Dokploy, поэтому
  стандартная логика проверки upstream releases не смешивается с fork metadata.
- Dashboard update check для форка сравнивает текущий Docker service digest с
  `ghcr.io/agenthits/dokploy:agenthits-stable`, поэтому UI ставит на
  установленный сервер только выпущенные релизы `agenthits-vX.Y.Z`.

### Преимущества форка

- Собственный GHCR image для ветки `AgentHits-Dev`: стабильный тег
  `agenthits-dev`, immutable short-sha tags и full-sha tags для rollback.
- Installer `install-agenthits.sh` ставит форк напрямую из GHCR, создает Docker
  secrets для runtime secret values и поддерживает `postgres:18+` volume target.
- Мониторинг содержит дополнительные улучшения: breakdown ресурсов контейнеров,
  детализацию Docker disk usage, отображение swap usage и историю занятого
  диска по категориям за день, 3, 7 и 30 дней с очисткой старых образов панели
  и кэша сборки.
- Добавлена безопасная upsert-логика application environment variables.
- Исправлено сопоставление GitHub webhook deploys по owner login.
- Ветка содержит security hardening поверх официального `v0.29.8`: проверки
  прав на server/update, registry, deployment worker jobs, schedule jobs,
  webhooks, trusted origins, SSO/domain boundaries, backup/log redaction и
  другие границы доступа.
- Image build обновлен для актуальных GitHub Actions refs, pinned
  Nixpacks/Railpack versions и amd64 GHCR публикации.

### Важно

Форк остается отдельной линией сборки поверх официального Dokploy. Для обычного
обновления используйте dashboard update button или `install-agenthits.sh
update`. CLI update использует отдельный `update.sh` и пропускает повторный pull,
если текущий service уже стоит на актуальном digest. Для rollback используйте
pinned image tag из
`ghcr.io/agenthits/dokploy`.

## English

AgentHits Dokploy is a fork of official Dokploy, built from the `AgentHits-Dev`
branch and published as:

```text
ghcr.io/agenthits/dokploy:agenthits-dev
```

The official base version and fork version are shown separately:

```text
Official: v0.29.8
Fork: agenthits-vX.Y.Z
```

`agenthits-vX.Y.Z` is the GitHub release the build belongs to: every PR merged
into `AgentHits-Dev` publishes a new release. A manual build between releases
shows as `agenthits-vX.Y.Z-<commits since the release>-g<short-sha>`.

### Why this helps

- You can see which official version is installed as the base.
- You can see which exact fork build is installed on top of that base.
- VPS state, GitHub Actions builds, and pinned Docker image tags are easier to
  compare.
- The official `package.json` version remains Dokploy's semver version, so
  upstream release checks are not mixed with fork metadata.
- The fork dashboard update check compares the current Docker service digest
  with `ghcr.io/agenthits/dokploy:agenthits-stable`, so the UI installs only
  published `agenthits-vX.Y.Z` releases on installed servers.

### Fork advantages

- Dedicated GHCR image for `AgentHits-Dev`: stable `agenthits-dev` tag,
  immutable short-sha tags, and full-sha tags for rollback.
- `install-agenthits.sh` installs the fork directly from GHCR, creates Docker
  secrets for runtime secret values, and supports the `postgres:18+` volume
  target.
- Monitoring includes extra improvements: container resource breakdown, Docker
  disk usage details, swap usage display, and a disk usage history by category
  for 1, 3, 7 and 30 days with a cleanup of old panel images and the build
  cache.
- Safe application environment variable upsert logic was added.
- GitHub webhook deploy matching was fixed to use owner login.
- The branch includes security hardening on top of official `v0.29.8`: access
  checks for server/update, registry, deployment worker jobs, schedule jobs,
  webhooks, trusted origins, SSO/domain boundaries, backup/log redaction, and
  other authorization boundaries.
- The image build was updated for current GitHub Actions refs, pinned
  Nixpacks/Railpack versions, and amd64 GHCR publishing.

### Important

This fork is a separate build line on top of official Dokploy. For normal
updates, use the dashboard update button or `install-agenthits.sh update`. The
CLI update path uses the separate `update.sh` module and skips pulling again
when the current service already runs the latest digest. For rollback, use a
pinned image tag from `ghcr.io/agenthits/dokploy`.
