<div align="center">
  <a href="https://dokploy.com">
    <img src=".github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%"  />
  </a>
  </br>
  </br>
  <p>Join us on Discord for help, feedback, and discussions!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield"/>
  </a>
</div>
<br />

# AgentHits Dokploy

Это форк Dokploy из ветки `AgentHits-Dev`. Последняя сборка публикуется в
GitHub Container Registry:

```text
ghcr.io/agenthits/dokploy:agenthits-dev
```

Dashboard показывает две версии:

```text
Official: v0.29.8
Fork: off_v0.29.8/Fork_<commits-since-official>+<short-sha>
```

`Official` - официальная база Dokploy, а `Fork` - сборка AgentHits поверх этой
базы. Преимущества форка описаны в
[docs/agenthits-fork.md](docs/agenthits-fork.md).

## Установка последней версии

Installer сам определяет систему: Linux (Ubuntu, Debian, Fedora, CentOS, RHEL,
Rocky, Alma, Arch, openSUSE, Alpine и их производные, x86 и ARM), macOS (через
OrbStack) и Windows (через WSL2). Подробности:
[docs/agenthits-install.md](docs/agenthits-install.md).

Требования: свободные порты `443` и `3000`, доступ к GitHub, GHCR и
Docker Hub.

Linux, macOS, WSL (на Linux без root скрипт сам вызовет `sudo`, на macOS
запускайте без `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh | bash
```

Windows, PowerShell от администратора:

```powershell
irm https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.ps1 | iex
```

После установки откройте адрес, который напечатает installer, обычно
`http://<IP>:3000`.

Проверка:

```bash
docker service ls
docker service ps dokploy --no-trunc
docker service ps dokploy-postgres --no-trunc
curl -i http://127.0.0.1:3000/api/trpc/settings.health
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

Ожидаемый health response:

```json
{"result":{"data":{"json":{"status":"ok"}}}}
```

Установка конкретной проверенной сборки:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh -o install-agenthits.sh
chmod +x install-agenthits.sh

DOKPLOY_IMAGE=ghcr.io/agenthits/dokploy:agenthits-dev-7bc40dd7fad5 \
DOKPLOY_RELEASE_TAG=agenthits-dev \
bash install-agenthits.sh
```

## Обновление установленного Dokploy

Если Dokploy уже установлен на VPS, не запускайте installer без аргументов.
Для установленного сервера используйте только команду `update`: она обновляет
Docker service `dokploy` на новый image и не переинициализирует окружение.

Обновление до последней сборки из `AgentHits-Dev`:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh -o install-agenthits.sh
chmod +x install-agenthits.sh

bash install-agenthits.sh update
```

Если установленный service уже указывает на актуальный digest и metadata,
`update` быстро завершится без повторного pull и без перезапуска `dokploy`.

Обновление до конкретной сборки:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh -o install-agenthits.sh
chmod +x install-agenthits.sh

DOKPLOY_IMAGE=ghcr.io/agenthits/dokploy:agenthits-dev-<short-sha> \
DOKPLOY_RELEASE_TAG=agenthits-dev \
bash install-agenthits.sh update
```

После обновления проверьте, что сервис запущен и использует ожидаемый image:

```bash
docker service ps dokploy --no-trunc
docker service logs --tail 80 dokploy
curl -i http://127.0.0.1:3000/api/trpc/settings.health
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

Dashboard update button в AgentHits fork проверяет и обновляет image из
`ghcr.io/agenthits/dokploy:agenthits-dev`.

Подробная инструкция: [docs/agenthits-install.md](docs/agenthits-install.md).

<details>
<summary>English installation guide</summary>

This is the AgentHits fork of Dokploy from the `AgentHits-Dev` branch. The
latest image is published to GitHub Container Registry:

```text
ghcr.io/agenthits/dokploy:agenthits-dev
```

The dashboard shows two versions:

```text
Official: v0.29.8
Fork: off_v0.29.8/Fork_<commits-since-official>+<short-sha>
```

`Official` is the official Dokploy base, and `Fork` is the AgentHits build on
top of that base. Fork advantages are documented in
[docs/agenthits-fork.md](docs/agenthits-fork.md).

Requirements:

- fresh Linux VPS with root or sudo access;
- `x86_64 / amd64` architecture;
- free ports `443` and `3000`;
- public access to GitHub, GHCR, and Docker Hub.

Install as root:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh | bash
```

Install with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh | sudo bash
```

Open after installation:

```text
http://YOUR_VPS_IP:3000
```

Verify:

```bash
docker service ls
docker service ps dokploy --no-trunc
docker service ps dokploy-postgres --no-trunc
curl -i http://127.0.0.1:3000/api/trpc/settings.health
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

Expected health response:

```json
{"result":{"data":{"json":{"status":"ok"}}}}
```

Install a specific tested build:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh -o install-agenthits.sh
chmod +x install-agenthits.sh

DOKPLOY_IMAGE=ghcr.io/agenthits/dokploy:agenthits-dev-7bc40dd7fad5 \
DOKPLOY_RELEASE_TAG=agenthits-dev \
bash install-agenthits.sh
```

## Updating an existing Dokploy installation

If Dokploy is already installed on the VPS, do not run the installer without
arguments. For an existing server, use only the `update` command: it updates the
`dokploy` Docker service to a new image and does not reinitialize the
environment.

Update to the latest `AgentHits-Dev` build:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh -o install-agenthits.sh
chmod +x install-agenthits.sh

bash install-agenthits.sh update
```

If the installed service already points to the current digest and metadata,
`update` exits quickly without pulling the same image again or restarting
`dokploy`.

Update to a specific build:

```bash
curl -fsSL https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.sh -o install-agenthits.sh
chmod +x install-agenthits.sh

DOKPLOY_IMAGE=ghcr.io/agenthits/dokploy:agenthits-dev-<short-sha> \
DOKPLOY_RELEASE_TAG=agenthits-dev \
bash install-agenthits.sh update
```

After updating, verify that the service is running and uses the expected image:

```bash
docker service ps dokploy --no-trunc
docker service logs --tail 80 dokploy
curl -i http://127.0.0.1:3000/api/trpc/settings.health
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

The dashboard update button in the AgentHits fork checks and updates the image
from `ghcr.io/agenthits/dokploy:agenthits-dev`.

Full guide: [docs/agenthits-install.md](docs/agenthits-install.md).

</details>

---

Dokploy is a free, self-hostable Platform as a Service (PaaS) that simplifies the deployment and management of applications and databases.

## ✨ Features

Dokploy includes multiple features to make your life easier.

- **Applications**: Deploy any type of application (Node.js, PHP, Python, Go, Ruby, etc.).
- **Databases**: Create and manage databases with support for MySQL, PostgreSQL, MongoDB, MariaDB, libsql, and Redis.
- **Backups**: Automate backups for databases to an external storage destination.
- **Docker Compose**: Native support for Docker Compose to manage complex applications.
- **Multi Node**: Scale applications to multiple nodes using Docker Swarm to manage the cluster.
- **Templates**: Deploy open-source templates (Plausible, Pocketbase, Calcom, etc.) with a single click.
- **Traefik Integration**: Automatically integrates with Traefik for routing and load balancing.
- **Real-time Monitoring**: Monitor CPU, memory, storage, and network usage for every resource.
- **Logs & Metrics**: Ship container logs and host/container metrics to Grafana (Loki, Prometheus/Mimir), Datadog, New Relic, InfluxDB, VictoriaMetrics, Better Stack, Elasticsearch/OpenSearch, Splunk, or AWS CloudWatch, tagged by project/environment/application.
- **Docker Management**: Easily deploy and manage Docker containers.
- **CLI/API**: Manage your applications and databases using the command line or through the API.
- **Notifications**: Get notified when your deployments succeed or fail (via Slack, Discord, Telegram, Email, etc.).
- **Multi Server**: Deploy and manage your applications remotely to external servers.
- **Self-Hosted**: Self-host Dokploy on your VPS.

## 🚀 Getting Started

To install the AgentHits fork, use the commands at the top of this README or
open the full fork guide:

[docs/agenthits-install.md](docs/agenthits-install.md)

For detailed documentation, visit [docs.dokploy.com](https://docs.dokploy.com).


[Github Sponsors](https://github.com/sponsors/Siumauricio)

### Contributors 🤝

<a href="https://github.com/dokploy/dokploy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=dokploy/dokploy" alt="Contributors" />
</a>

## 📺 Video Tutorial

<a href="https://youtu.be/mznYKPvhcfw">
  <img src="https://dokploy.com/banner.png" alt="Watch the video" width="400"/>
</a>

## 🤝 Contributing

Check out the [Contributing Guide](CONTRIBUTING.md) for more information.
