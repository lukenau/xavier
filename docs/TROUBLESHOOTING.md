# Troubleshooting

Quick diagnosis path: check the installer output → check `docker compose ps`
→ check logs (`./install.sh --logs`) → match a symptom below.

---

## Installer fails at the prerequisite checks

| Message | Fix |
|---|---|
| `Docker not found` | Install Docker Engine: <https://docs.docker.com/engine/install/> (Mac: install and launch Docker Desktop). |
| `Docker Compose v2 not found (need the 'docker compose' plugin, not 'docker-compose')` | Old `docker-compose` (v1) is installed but not the v2 plugin. Install the `docker-compose-plugin` package, or upgrade Docker. Verify with `docker compose version`. |
| `Cannot reach the Docker daemon` | The daemon isn't running: `sudo systemctl start docker` (Linux) or launch Docker Desktop (Mac). On a NAS, enable the Docker service. If it is running, add your user to the `docker` group and log in again. |

## `Server did not report healthy in 90s`

The build succeeded but the container never answered `/api/healthz` within
90 s.

1. Look at the logs: `./install.sh --logs`
2. `docker compose ps`: is the container `Up (healthy)`, restarting, or exited?
3. Common causes:
   - **Port 8090 already in use** by another service:

     ```bash
     sudo ss -ltnp | grep 8090     # Linux
     lsof -i :8090                 # macOS
     ```

     Stop the other service, or set `HUB_PORT` (in `.env`, or in the
     environment) to a free port and re-run `./install.sh`. The container
     always listens on 8090 internally; `HUB_PORT` only moves the host side.
     If you change it, point your mesh or proxy at the new port.
   - **First build was slow.** On a small VPS the image build can take a few
     minutes; the 90 s health wait may time out even though the container
     comes up right after. Run `./install.sh --status` or
     `curl http://127.0.0.1:8090/api/healthz` a minute later.

## Permission problems on the data directory

The container runs as a non-root user (uid from the `HUB_UID` build arg,
default `1000`). If `docker compose logs` shows `EACCES` / `Permission
denied` writes under `/data`, the host data dir is owned by a different uid:

```bash
sudo chown -R 1000:1000 ./data
```

Or set `HUB_UID` in `.env` to the owner's uid and rebuild:
`docker compose up -d --build`.

## I changed `.env` and nothing happened

Run `./install.sh --restart`. It recreates the container
(`docker compose up -d --force-recreate`), which re-reads `.env`. A plain
`docker compose restart` keeps the old environment.

## The app can't connect

Work through in order:

1. **Is the address `https://`?** The app accepts `http://` only for
   `localhost` and `127.0.0.1`, and refuses anything else when you save
   **Config → Server address**. A LAN address such as `http://192.168.1.50:8090`
   will not work; give the server an HTTPS address as described in
   [CONNECT-APP.md](CONNECT-APP.md).
2. **Is the server reachable from that device?**

   ```bash
   curl -fsS <server-url>/api/healthz
   ```

   - Works on the server (`http://127.0.0.1:8090`) but not from your phone:
     the hub is loopback-only, which is the default. Publish it over your mesh
     (`sudo tailscale serve --bg --https=443 http://127.0.0.1:8090`) and check
     the phone is signed in to the same tailnet. Do **not** bind `0.0.0.0` on
     an internet-facing machine.
   - Fails everywhere: the container is down; see above.
3. **`421 Misdirected Request`.** The server answers only to host names it
   knows: the one in `HUB_ORIGIN`, `localhost`, and any listed in
   `HUB_ALLOWED_HOSTS`. Set `HUB_ORIGIN` to the address you use (or add the name
   to `HUB_ALLOWED_HOSTS`) and re-run `./install.sh`; a plain restart does not
   re-read `.env`.
4. **401 / 412 responses.** Gated routes lock individually. A lock returns
   `412 no_passkey` when no passkey or paired phone is enrolled yet (pair one;
   there is nothing to unlock with before that), and `401 chat_locked` /
   `401 terminal_locked` once a credential exists but the session has lapsed
   (unlock again with Face ID). Chat and the terminal, including the tmux
   session lists, need their session cookie; most other reads do not. There is
   no API token to set (see [SECURITY.md](../SECURITY.md)).
5. **Passkey setup fails with "WebAuthn is not configured".** (Only for a browser
   client of your own; the app pairs a device key instead.) `HUB_ORIGIN` is
   blank, or it doesn't match the address in the browser's bar. Set it to the
   exact origin (scheme + host + port) you reach the hub on, for example
   `https://<machine>.<tailnet>.ts.net`, then re-run `./install.sh`. A
   comma-separated list is accepted; the first entry is the WebAuthn origin.
6. **URL mistakes.** The server address must include the scheme:
   `https://<machine>.<tailnet>.ts.net`, not just the host name.

## Chat opens but nothing answers

Chat needs Hermes with the hub-platform plugin installed, `HERMES_API_BASE` and
`HERMES_API_KEY` set in `.env`, and the same platform key on both sides. Check
each against
[hermes-plugin/hub-platform/README.md](../hermes-plugin/hub-platform/README.md).

## Server unreachable after a reboot

- `docker compose ps`: the container should auto-start
  (`restart: unless-stopped`) once the Docker daemon is up. If it shows
  `Exited`, start it with `./install.sh`.
- `tailscale serve status`: the serve configuration should survive a reboot
  (`--bg` makes it persistent). If it is gone, run the `tailscale serve`
  command again.
- Mac: Docker Desktop must launch at login, and the Mac must not sleep
  (see [INSTALL-MAC.md](INSTALL-MAC.md)).

## Lost / resetting everything

- **Logs**: `./install.sh --logs` (or `docker compose logs -f hub-api`).
- **Restart fresh without losing data**: `./install.sh --stop && ./install.sh`.
- **Full reset (deletes your data and `.env`)**:

  ```bash
  ./install.sh --stop
  sudo rm -rf "${HUB_DATA_DIR:-./data}" .env
  ./install.sh
  ```

## Still stuck

Open a [GitHub issue](https://github.com/lukenau/xavier/issues) with: the exact
command, the full installer output, `docker compose ps`, and the last ~50 lines
of `./install.sh --logs`. Redact any credentials (API keys, tokens) and any
addresses you would rather keep private.
