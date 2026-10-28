# Усиление защиты серверов: SSH, UFW, Fail2Ban

Что включается, как запустить, как проверить, как откатить и как удалить сервер.

## Что делает каждый флаг

| Флаг установщика | Переменная окружения | Что делает |
|---|---|---|
| `--ssh-keys-only` | `HARDEN_SSH=1` | Вход только по ключу: `PasswordAuthentication no`, `UsePAM no`, `PermitRootLogin prohibit-password`. Требует валидный ключ в `/root/.ssh/authorized_keys`. Пропускается, если на хосте нет sshd. |
| `--ufw` | `HARDEN_UFW=1` | UFW: входящие запрещены, разрешены SSH, 443 (tcp, и 443 udp для HTTP/3). Пересылка для Docker разрешена. Только Debian и Ubuntu. |
| `--fail2ban` | `HARDEN_FAIL2BAN=1` | Fail2Ban: защита sshd в режиме `aggressive`, настройка в `/etc/fail2ban/jail.local`. Только Debian и Ubuntu. |
| `--harden` | все три | Все три флага сразу. |
| — | `DOKPLOY_SERVER_HARDENING=ssh,ufw,fail2ban` | То же самое панель применяет к новым серверам в «Setup Server». Если задан флаг установки, переменная выставляется автоматически. |

Версия Traefik для серверов берётся из установщика: `TRAEFIK_IMAGE`, сейчас `traefik:v3.7.16`. Тест `apps/dokploy/__test__/server/component-versions-sync.test.ts` падает, если версия по умолчанию в панели расходится с установщиком.

Флаги усиления принимают только `install` и `harden`. `install-agenthits.sh update` обновляет панель и её стек, но не меняет SSH, UFW и Fail2Ban.

## Как запускать

### macOS (панель установлена в OrbStack)

```bash
bash install-agenthits.sh install --harden
```

Флаги передаются в машину `dokploy`, там же и выполняется усиление. Вход по SSH в OrbStack-машине по умолчанию не настроен, поэтому блок SSH будет пропущен с сообщением.

### Linux

```bash
sudo bash install-agenthits.sh install --harden
```

### Windows (WSL)

```powershell
$env:HARDEN_SSH = '1'; $env:HARDEN_UFW = '1'; $env:HARDEN_FAIL2BAN = '1'
irm https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev/install-agenthits.ps1 | iex
```

Windows-установщик скачивает `install-agenthits.sh` с GitHub. Изменения появятся на Windows только после пуша в ветку `AgentHits-Dev`.

### Уже установленная панель (macOS)

Усилить хост панели:

```bash
bash install-agenthits.sh harden --harden
```

Включить усиление для новых серверов, которые настраиваются через панель:

```bash
orb -m dokploy -u root docker service update --env-add DOKPLOY_SERVER_HARDENING=ssh,ufw,fail2ban dokploy
```

Чтобы панель использовала новый код, в образ сервиса должна попасть сборка с этими изменениями (после пуша и сборки образа).

### Уже подключённый сервер: кнопка в панели

Settings → Servers → сервер → Setup Server → Security → **Apply hardening**. Переменная `DOKPLOY_SERVER_HARDENING` для этого не нужна.

- В окне три галочки: UFW, SSH только по ключу, Fail2Ban. Заранее отмечены пункты, которые проверка показала красными.
- Скрипт выполняется на сервере по SSH. Лог идёт в окне в реальном времени и сохраняется как деплой «Security hardening» сервера (Settings → Deployments).
- После завершения проверка Security обновляется сама.
- Нужно право `server.execute`. Пользователь SSH должен быть root или иметь sudo без пароля, иначе скрипт останавливается с ошибкой.
- Перед обновлением пакетов apt ждёт до 5 минут, если его занял unattended-upgrades.
- Если в `/etc/fail2ban/jail.local` нет секции `[sshd]`, она дописывается в конец файла. Существующая секция `[sshd]` не меняется, тогда пункт SSH Mode может остаться красным.

## Как проверить

Во вкладке Security панели: Settings → Servers → сервер → Setup Server → Security → Refresh. Все пункты должны быть зелёными.

Вручную на сервере (только чтение):

```bash
sshd -T | grep -E '^(passwordauthentication|usepam|permitrootlogin) '
ufw status verbose
fail2ban-client status sshd
```

Ожидаемо: `passwordauthentication no`, `usepam no`, `permitrootlogin prohibit-password`, `Status: active` с `deny (incoming)`, и jail `sshd` активен.

## Откат

### VPS, настроенный вручную и через панель

Выполнять от root на сервере. Открой отдельное окно по ключу и не закрывай текущую сессию, пока не проверишь вход.

```bash
ufw --force disable
systemctl disable --now fail2ban
rm -f /etc/fail2ban/jail.local /etc/ssh/sshd_config.d/00-hardening.conf
cp -p /etc/ssh/sshd_config.dokploy-backup /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
```

Если `jail.local` был на сервере до усиления, не удаляй его целиком: убери только секцию `[sshd]`, которую дописала панель.

Удалить пакеты (по желанию):

```bash
apt-get purge -y ufw fail2ban
```

Если сервер настраивал установщик через `--ssh-keys-only`, бэкап называется `/etc/ssh/sshd_config.agenthits-backup`. Используй его вместо `dokploy-backup`.

После отката вход по паролю снова включён, если на сервере стоит оригинальный конфиг. Убедись, что пароль root известен, прежде чем откатывать.

### Панель на macOS

Убрать настройку усиления для новых серверов:

```bash
orb -m dokploy -u root docker service update --env-rm DOKPLOY_SERVER_HARDENING dokploy
```

## Как удалить сервер

1. Из панели: Settings → Servers (`/dashboard/settings/servers`), выбрать сервер и удалить его там. Это не трогает сам VPS.
2. С VPS:
   - откат, описанный выше, если сервер нужен дальше;
   - или переустановка ОС в панели хостинга. **Необратимо**: стирает весь диск, включая Docker, ключи и данные. Сначала сохрани бэкап.
3. Панель целиком (машина OrbStack):

   ```bash
   orb delete dokploy
   ```

   **Необратимо**: удаляет машину OrbStack вместе с панелью, её базой и секретами. Сначала сохрани бэкап.

## Ограничения

- UFW не закрывает порты, которые публикует Docker. Проверено на тестовом VPS: тестовый контейнер на порту 8088 открывался из интернета при `deny`. Закрыть такие порты можно правилами в `DOCKER-USER` или публикацией на `127.0.0.1`. По умолчанию это не включено.
- `UsePAM no` означает, что для SSH-сессий не применяются `pam_limits` и `pam_systemd`. Вход по ключу проверен и работает.
- UFW и Fail2Ban настраиваются только на Debian и Ubuntu. На других системах блок пропускается, и пункты Security остаются красными.
- Блок SSH пропускается, если на хосте нет sshd (OrbStack-машина и WSL по умолчанию).
