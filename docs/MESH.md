# Reach your hub from your phone — mesh and tunnel options

The server binds to `127.0.0.1` by default: reachable only from the machine it
runs on. To use the app from a phone you need a path to it. **A private mesh is
the recommended path**: it gets you an encrypted, stable HTTPS address without
opening a port to the internet or buying a domain.

> The app accepts `http://` only for `localhost` and `127.0.0.1`, and iOS
> enforces HTTPS for anything else too (App Transport Security). Whatever you
> choose must give the app an **`https://` address** with a certificate the
> iPhone trusts. `tailscale serve` does this for free.

Most of the hub's reads carry no credential (see
[SECURITY.md](../SECURITY.md)), so who can reach the address matters as much as
the encryption.

| Option | Exposed to internet | HTTPS | Needs a domain | Effort |
|---|---|---|---|---|
| **Tailscale** (recommended) | No | Yes (automatic) | No | Low |
| Headscale (self-hosted control plane) | No | You provide the certificate | Usually | High |
| WireGuard (raw) | No | You provide the certificate | Usually | Medium |
| Cloudflare Tunnel | Yes, unless Cloudflare Access gates it | Yes | Yes | Medium |
| Public reverse proxy | **Yes** | Yes | Yes | Medium |
| Plain HTTP on your LAN | No | No: **does not work with the app** | No | n/a |

---

## Tailscale (recommended)

One command on the server and one app on the phone; both end up on the same
private network with an HTTPS name. `./scripts/setup-mesh.sh` automates the
server side (join, publish, print the URL) and never runs `funnel`.

### 1. Server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                      # sign in with the same account as the phone
```

### 2. Publish the hub over the tailnet

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8090
tailscale serve status                 # confirm, and read your URL
```

`serve` keeps the server itself on loopback and puts an HTTPS proxy in front of
it that only devices on your tailnet can reach. `--https` needs HTTPS
certificates enabled for the tailnet: in the Tailscale admin console, turn on
MagicDNS and HTTPS certificates (DNS page). The URL looks like:

```
https://<machine>.<your-tailnet>.ts.net/
```

Plain `--http=80` is simpler but gives an `http://` URL that the app and iOS
will refuse; use `--https`, which provisions a real certificate.

Then set that address in `.env` as `HUB_PUBLIC_BASE` and `HUB_ORIGIN` (which
also tells the server to answer to that host name) and re-run `./install.sh`.

### 3. Phone

1. Install the Tailscale app and sign in to the **same tailnet**.
2. In the Xavier app, type `https://<machine>.<your-tailnet>.ts.net` into
   **Config → Server address**; see [CONNECT-APP.md](CONNECT-APP.md).
3. Pair the phone with a code from `./install.sh --pair`.

### Notes

- **Never use `tailscale funnel`.** Funnel exposes the service to the *public*
  internet. `serve` is tailnet-only; that is the whole point.
- **Everyone on your tailnet can reach it.** If you share your tailnet with
  other people or devices, use Tailscale's access controls to limit who can
  reach the server.
- **MagicDNS and a work VPN.** If the phone also runs another VPN, the `.ts.net`
  name may not resolve. The certificate is issued for the name, so reaching the
  hub by its tailnet IP address instead will fail the HTTPS check; fix the DNS
  (or the VPN's split-DNS settings) rather than switching to the IP.
- **Keep the name stable.** The URL comes from the server's machine name; rename
  it casually and every phone needs the new address.
- **The hub container does not need Tailscale.** Only the *host* publishes it;
  the container keeps listening behind `127.0.0.1:8090`.

---

## Headscale (self-hosted control plane)

If you want a mesh without Tailscale's coordination server, Headscale is an
open-source reimplementation of it. You run the control plane, and the clients
are normal Tailscale clients pointed at it:

```bash
tailscale up --login-server https://headscale.example.com
```

Trade-off: you now operate the control plane, its TLS, and node registration,
and you need your own way to give the hub an HTTPS certificate the iPhone
trusts (for example a domain you own, with a DNS-validated certificate, that
resolves to the hub's mesh address). Use it if "no third-party coordination
server" is a hard requirement and you are willing to run the service.

---

## WireGuard (raw)

The lowest-level mesh. It gives you an encrypted interface between the server
and the phone, but **no built-in HTTPS, DNS, or NAT traversal**, and managing iOS
configs by hand is fiddly. You still need an `https://` address the iPhone
trusts in front of the hub, such as a reverse proxy on the server's WireGuard
address with a certificate for a domain you own. Only worth it if you already
run WireGuard for other reasons.

---

## Cloudflare Tunnel

A tunnel publishes the hub on a hostname you own, with Cloudflare terminating
TLS, without opening a port on your machine:

```bash
cloudflared tunnel --url http://127.0.0.1:8090
```

By itself that makes the hostname reachable from the whole internet, with every
unauthenticated read on it. Cloudflare Access can gate it, but an Access policy
that asks for a browser login also blocks the app, which cannot complete that
login. Cloudflare's device client (WARP) can identify the phone to Access
without a browser login; setting that up is beyond this guide. Traffic also
transits Cloudflare. Set `HUB_ORIGIN` and `HUB_PUBLIC_BASE` to the tunnel
hostname and keep `HUB_BIND=127.0.0.1`.

---

## Public reverse proxy (not recommended)

You can put nginx or Caddy in front with TLS, keep the server bound to loopback,
and point a public domain at it. Read [SECURITY.md](../SECURITY.md) first: you
would be publishing a service whose unauthenticated reads include your agent's
transcripts, calendar, files and costs. An authenticating proxy would close that
gap, but the app cannot sign in to one.

---

## Plain HTTP on your LAN — does not work with the app

Pointing the app at `http://<lan-ip>:8090` fails twice over: the server binds
`127.0.0.1`, so nothing else on your network reaches it, and the app refuses
`http://` for anything but `localhost`. Binding wider (`HUB_BIND=0.0.0.0`) lets
`curl` and browsers on the LAN reach it, along with every other device on that
network, but the app still will not connect. Use Tailscale: at home it connects
directly over your LAN anyway.
